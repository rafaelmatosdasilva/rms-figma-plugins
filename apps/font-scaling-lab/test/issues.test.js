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

  it('suggests a width fix when the overflow is horizontal, not height', async () => {
    // Reported case: an input whose text overflows horizontally, inside a container
    // whose FIXED axis is height (its width fills the modal). The advice must address
    // the axis that actually overflowed (width), not the axis that happens to be fixed.
    const text = makeText('A long input value that does not fit on one line', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 300, height: 20, textAutoResize: 'HEIGHT',
    });
    const input = makeNode('FRAME', {
      name: 'Input', width: 100, height: 40,
      layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED',
    });
    input.appendChild(text);
    const frame = makeNode('FRAME', { name: 'Modal', width: 320, height: 200 });
    frame.appendChild(input);

    frame.absoluteBoundingBox = bbox(0, 0, 320, 200);
    input.absoluteBoundingBox = bbox(0, 0, 100, 40);
    text.absoluteBoundingBox = bbox(0, 0, 300, 20); // spills out horizontally, not vertically

    const { lastOf } = await previewWith(frame);
    const issues = lastOf('preview-result').issues;

    expect(issues.length).toBeGreaterThan(0);
    const culprit = issues[0];
    expect(culprit.suggestedFixes[0].title).toMatch(/width/i);
    expect(culprit.suggestedFixes[0].title).not.toMatch(/height/i);
  });

  it('names the tightest cap up the chain as the root cause, not the immediate parent', async () => {
    // The reported case: flexible text overflows horizontally; the immediate parents
    // are Hug; the real constraint is a maxWidth on a container several levels up.
    const text = makeText('A value long enough to overflow the capped container', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 500, height: 20, textAutoResize: 'WIDTH_AND_HEIGHT',
    });
    const hug1 = makeNode('FRAME', { name: 'Row', layoutSizingHorizontal: 'HUG', width: 500, height: 20 });
    const hug2 = makeNode('FRAME', { name: 'Group', layoutSizingHorizontal: 'HUG', width: 500, height: 20 });
    const capped = makeNode('FRAME', { name: 'Card', layoutSizingHorizontal: 'HUG', maxWidth: 300, width: 300, height: 40 });
    const modal = makeNode('FRAME', { name: 'Modal', layoutSizingHorizontal: 'FIXED', width: 360, height: 200 });

    hug1.appendChild(text);
    hug2.appendChild(hug1);
    capped.appendChild(hug2);
    modal.appendChild(capped);

    modal.absoluteBoundingBox = bbox(0, 0, 360, 200);
    capped.absoluteBoundingBox = bbox(0, 0, 300, 40);  // capped at its maxWidth
    hug2.absoluteBoundingBox = bbox(0, 0, 500, 20);    // grows with content
    hug1.absoluteBoundingBox = bbox(0, 0, 500, 20);
    text.absoluteBoundingBox = bbox(0, 0, 500, 20);    // overflows the 300-capped Card

    const { lastOf } = await previewWith(modal);
    const issues = lastOf('preview-result').issues;

    expect(issues.length).toBeGreaterThan(0);
    const culprit = issues[0];
    // The Card (maxWidth 300) is tighter than the Modal (fixed 360) — it wins over
    // both the Hug parents and the wider fixed ancestor.
    expect(culprit.name).toBe('Card');
    expect(culprit.suggestedFixes[0].title).toMatch(/max width/i);
    expect(culprit.suggestedFixes[0].description).toMatch(/300/); // names the actual cap value
  });

  it('flags the selected root frame itself when it is the fixed constraint', async () => {
    // The reported instance case, reduced: the selected frame is the only thing that
    // cannot grow; every container in between hugs, so the content overflows only the
    // root. The root was previously excluded from the check, so nothing was reported.
    const text = makeText('A value wide enough to overflow the fixed root frame', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 500, height: 20, textAutoResize: 'WIDTH_AND_HEIGHT',
    });
    const hug = makeNode('FRAME', { name: 'Row', layoutSizingHorizontal: 'HUG', width: 500, height: 20 });
    const root = makeNode('FRAME', { name: 'Card', layoutSizingHorizontal: 'FIXED', width: 300, height: 100 });
    hug.appendChild(text);
    root.appendChild(hug);

    root.absoluteBoundingBox = bbox(0, 0, 300, 100);
    hug.absoluteBoundingBox = bbox(0, 0, 500, 20);   // hugs the content, overflowing the root
    text.absoluteBoundingBox = bbox(0, 0, 500, 20);

    const { lastOf } = await previewWith(root);
    const issues = lastOf('preview-result').issues;

    expect(issues.length).toBeGreaterThan(0);        // previously zero: the root was skipped
    expect(issues[0].name).toBe('Card');             // the selected root is the culprit
    expect(issues[0].suggestedFixes[0].title).toMatch(/width/i);
  });

  it('does not flag a FILL root as fixed-width (its size comes from its parent)', async () => {
    // A layer that FILLS its parent renders at a fixed size when previewed off-canvas
    // (FILL needs an auto-layout parent). That is a preview artifact, not a real fixed
    // width — the plugin must read the ORIGINAL sizing and not report it as clipped.
    const text = makeText('A value that would overflow if the root were fixed', {
      fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
      width: 500, height: 20, textAutoResize: 'WIDTH_AND_HEIGHT',
    });
    const hug = makeNode('FRAME', { name: 'Row', layoutSizingHorizontal: 'HUG', width: 500, height: 20 });
    // The selected root fills its parent horizontally; only its height is fixed.
    const root = makeNode('FRAME', {
      name: 'Card', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED',
      width: 392, height: 32,
    });
    hug.appendChild(text);
    root.appendChild(hug);

    root.absoluteBoundingBox = bbox(0, 0, 392, 32);
    hug.absoluteBoundingBox = bbox(0, 0, 500, 20);
    text.absoluteBoundingBox = bbox(0, 0, 500, 20); // "overflows" the 392 root horizontally

    const { lastOf } = await previewWith(root);
    const issues = lastOf('preview-result').issues;

    // The only horizontal constraint is the FILL root, which is a preview artifact.
    const widthClaims = issues.filter((i) => /fixed width/i.test(i.description || ''));
    expect(widthClaims).toEqual([]);
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
