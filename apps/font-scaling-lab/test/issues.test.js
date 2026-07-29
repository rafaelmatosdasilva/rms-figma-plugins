import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makePage, makeNode, makeText } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

const bbox = (x, y, width, height) => ({ x, y, width, height });

/**
 * Issues are only detected on a scaled preview: the plugin clones the frame, scales
 * the clone's text, then walks it. `_textClips` is stamped by the scaler when text
 * no longer fits its fixed box — the mock can't re-measure, so fixtures pre-stamp it
 * on the original and the deep clone carries it over.
 */
async function previewWith(frame, { scale = 2 } = {}) {
  const page = makePage('Page 1');
  page.appendChild(frame);
  page.selection = [frame];

  const harness = await loadPlugin(ENTRY, { pages: [page] });
  harness.figma.currentPage = page;
  await harness.send({ type: 'preview', scale, dpr: 2 });
  return harness;
}

describe('font-scaling-lab — reported issues', () => {
  it('reports text that no longer fits its box', async () => {
    const text = makeText('A label that outgrew its box', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 100, height: 20, textAutoResize: 'NONE',
    });
    text.setPluginData('_textClips', '1');
    text.setPluginData('_textClipAxis', 'h');

    const frame = makeNode('FRAME', { name: 'Card', width: 320, height: 200 });
    frame.appendChild(text);

    const { lastOf } = await previewWith(frame);

    const { issues } = lastOf('preview-result');
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('TEXT');
  });

  it('describes each issue well enough for the panel to act on it', async () => {
    const text = makeText('Some long label', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 100, height: 20, textAutoResize: 'NONE',
    });
    text.setPluginData('_textClips', '1');
    const frame = makeNode('FRAME', { name: 'Card', width: 320, height: 200 });
    frame.appendChild(text);

    const { lastOf } = await previewWith(frame);
    const issue = lastOf('preview-result').issues[0];

    // The contract the UI relies on.
    expect(['clipped', 'truncation']).toContain(issue.severity);
    expect(issue.reasons.length).toBeGreaterThan(0);
    expect(issue.description).toBeTruthy();
    // Always exactly two ways forward, the first one recommended.
    expect(issue.suggestedFixes).toHaveLength(2);
    expect(issue.suggestedFixes[0].recommended).toBe(true);
    // Points at the real layer, not the throwaway clone.
    expect(issue.nodeId).toBe(text.id);
  });

  it('calls a capped text layer truncated rather than clipped', async () => {
    const text = makeText('Two lines max', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 100, height: 20, textAutoResize: 'TRUNCATE',
    });
    // No _textClips stamp: truncation is inferred from the layer's own settings.
    text.setPluginData('_textClips', '');
    // The text must escape an ancestor *inside* the previewed frame, so there has
    // to be a container between them — the frame itself is the comparison root.
    const inner = makeNode('FRAME', { name: 'Row', width: 100, height: 40 });
    inner.appendChild(text);
    const frame = makeNode('FRAME', { name: 'Card', width: 320, height: 200 });
    frame.appendChild(inner);

    frame.absoluteBoundingBox = bbox(0, 0, 320, 200);
    inner.absoluteBoundingBox = bbox(0, 0, 100, 40);
    text.absoluteBoundingBox = bbox(0, 0, 900, 20); // spills out of `inner`

    const { lastOf } = await previewWith(frame);
    const issues = lastOf('preview-result').issues;

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.severity === 'truncation')).toBe(true);
  });

  it('blames the container when flexible text escapes a fixed one', async () => {
    // Text that can grow, trapped in a container that cannot — the container is the
    // thing to fix, so it becomes the culprit and gets container-shaped advice.
    const text = makeText('Flexible text that overflows', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 400, height: 20, textAutoResize: 'HEIGHT',
    });
    const inner = makeNode('FRAME', {
      name: 'Fixed box', width: 100, height: 40, layoutSizingHorizontal: 'FIXED',
    });
    inner.appendChild(text);
    const frame = makeNode('FRAME', { name: 'Card', width: 320, height: 200 });
    frame.appendChild(inner);

    frame.absoluteBoundingBox = bbox(0, 0, 320, 200);
    inner.absoluteBoundingBox = bbox(0, 0, 100, 40);
    text.absoluteBoundingBox = bbox(0, 0, 400, 20); // spills out of `inner`

    const { lastOf } = await previewWith(frame);
    const issues = lastOf('preview-result').issues;

    expect(issues.length).toBeGreaterThan(0);
    const culprit = issues[0];
    expect(culprit.kind).toBe('FRAME');           // the container, not the text
    expect(culprit.severity).toBe('clipped');     // non-text culprits are always clipped
    expect(culprit.suggestedFixes).toHaveLength(2);
    expect(culprit.suggestedFixes[0].title).toMatch(/width/i);
  });

  it('reports nothing when everything still fits', async () => {
    const text = makeText('Short', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' }, width: 60, height: 20,
    });
    const frame = makeNode('FRAME', { name: 'Card', width: 320, height: 200 });
    frame.appendChild(text);
    frame.absoluteBoundingBox = bbox(0, 0, 320, 200);
    text.absoluteBoundingBox = bbox(0, 0, 60, 20);

    const { lastOf } = await previewWith(frame);
    expect(lastOf('preview-result').issues).toEqual([]);
  });
});
