import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadUI } from '@rms/test-utils';

const UI = fileURLToPath(new URL('../ui.html', import.meta.url));

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

/** What the plugin reports after looking at the selection. */
const selection = (over = {}) => ({
  nodeId: 'frame-1',
  name: 'Card',
  type: 'FRAME',
  width: 320,
  height: 200,
  total: 2,
  counts: { variable: 1, style: 0, override: 1 },
  nodes: [
    { id: 't1', name: 'Heading', preview: 'Welcome', source: 'variable', value: 24, tokenName: 'font/size/lg' },
    { id: 't2', name: 'Caption', preview: 'Small print', source: 'override', value: 12 },
  ],
  ...over,
});

describe('font-scaling-lab UI — boot', () => {
  it('loads and shows the empty state', () => {
    ui = loadUI(UI);
    expect(ui.$('#empty-state')).toBeTruthy();
    expect(ui.$('#scan-btn')).toBeTruthy();
  });

  it('cannot scan until something is selected', () => {
    ui = loadUI(UI);
    expect(ui.$('#scan-btn').disabled).toBe(true);
  });
});

describe('font-scaling-lab UI — selection', () => {
  it('names the selected frame and enables scanning', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: selection() });

    expect(ui.text('#frame-name')).toBe('Card');
    expect(ui.$('#scan-btn').disabled).toBe(false);
  });

  it('explains what to select when nothing is', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: { error: 'no-selection' } });

    expect(ui.$('.empty-state p').textContent).toMatch(/select a frame/i);
    expect(ui.$('#scan-btn').disabled).toBe(true);
  });

  it('asks for a single frame when several are selected', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: { error: 'multi-selection' } });

    expect(ui.$('.empty-state p').textContent).toMatch(/only one/i);
  });

  it('says which kinds of layer it can work with', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: { error: 'invalid-type' } });

    expect(ui.$('.empty-state p').textContent).toMatch(/frame, component/i);
  });

  it('enables scanning only while the selection is valid', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'sel-state', valid: true, hasLocked: false, nodeId: 'frame-1' });
    expect(ui.$('#scan-btn').disabled).toBe(false);

    ui.receive({ type: 'sel-state', valid: false, hasLocked: true, nodeId: null });
    expect(ui.$('#scan-btn').disabled).toBe(true);
  });
});

describe('font-scaling-lab UI — preview', () => {
  const previewResult = (over = {}) => ({
    type: 'preview-result',
    scale: 2,
    name: 'Card',
    frameId: 'frame-1',
    scaled: [137, 80, 78, 71], // PNG magic bytes are enough for an <img> src
    issues: [],
    frameW: 320,
    frameH: 200,
    ...over,
  });

  it('asks the plugin to render when scanning starts', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: selection() });
    ui.click('#scan-btn');

    const [msg] = ui.sentOf('preview');
    expect(msg).toBeTruthy();
    expect(typeof msg.scale).toBe('number');
  });

  it('shows the rendered preview', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: selection() });
    ui.receive(previewResult());

    expect(ui.$('#preview-grid').innerHTML.length).toBeGreaterThan(0);
  });

  it('reports when nothing broke at this scale', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: selection() });
    ui.receive(previewResult({ issues: [] }));

    // No issues listed — the panel should not invent any.
    expect(ui.$$('#issues-list .lrow').length).toBe(0);
  });

  it('lists the problems it found', async () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection', data: selection() });
    ui.receive(previewResult({
      issues: [{
        type: 'clipped', severity: 'clipped', name: 'Heading', chars: 'Welcome to the thing',
        parentName: 'Card', bounds: { x: 0, y: 0, w: 100, h: 20 }, nodeId: 't1',
        outOfBounds: false, fontInfo: { source: 'variable', value: 24, tokenName: 'font/size/lg' },
        reasons: [{ what: 'Auto resize: Fixed size', fix: 'Set it to Hug' }],
        description: 'Heading is clipped by its container at 200% scale',
        recommendation: null, kind: 'TEXT',
        typography: null, sizing: null, bindings: [], parentCtx: null, scale: null,
        suggestedFixes: [
          { title: 'Set text resize to Hug', description: 'Grows with content', recommended: true, nodeId: 't1' },
          { title: 'Set parent width to Hug', description: 'Container sizes to text' },
        ],
      }],
    }));

    // The list is written on the next frame so the preview image paints first.
    await new Promise((r) => setTimeout(r, 50));

    const list = ui.$('#issues-list');
    // The row is identified by the text that broke, which is what a designer looks
    // for — not by the layer name.
    expect(list.textContent).toContain('Welcome to the thing');
    expect(list.textContent).toContain('Clipped'); // grouped under its severity, with a count
    expect(list.textContent).toMatch(/Clipped\s*·\s*1/);
  });

  it('surfaces a preview failure', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'error', message: 'Preview failed: boom' });

    expect(ui.document.body.textContent).toContain('boom');
  });
});

describe('font-scaling-lab UI — panel widths', () => {
  it('restores a stored panel width', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'panel-width', width: 380 });

    // Applied to the layout, not just remembered.
    expect(ui.document.body.innerHTML).toContain('380');
  });
});
