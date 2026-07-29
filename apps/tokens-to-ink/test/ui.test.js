import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadUI } from '@rms/test-utils';

const UI = fileURLToPath(new URL('../ui.html', import.meta.url));

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

/** Let the UI's requestAnimationFrame work settle. */
const painted = () => new Promise((r) => setTimeout(r, 50));

const colour = (over = {}) => ({
  source: 'variable',
  colorVarId: 'v-brand',
  name: 'brand/primary',
  hex: '#FF0000',
  collectionName: 'Tokens',
  isExternal: false,
  hasCmykVariable: false,
  cmyk: { c: 0, m: 100, y: 100, k: 0 }, // the plugin always sends one: the saved tag, or computed from RGB
  pantone: null, ral: null, vinyl: null,
  suggestedCmyk: { c: 0, m: 100, y: 100, k: 0 },
  nodeIds: ['rect-1'],
  ...over,
});

function scanResults(data = [colour()]) {
  return {
    type: 'scan-results',
    data,
    sourceNodes: [{ id: 'frame-1', name: 'Artwork' }],
    hasExternalVars: false,
    externalLibrary: null,
    summary: { totalColors: data.length, withCmykPairs: data.filter((d) => d.hasCmykVariable).length },
  };
}

describe('tokens-to-ink UI — boot', () => {
  it('loads without errors', () => {
    ui = loadUI(UI);
    expect(ui.$('#color-body')).toBeTruthy();
  });

  it('lets you scan with nothing selected — the whole file is a valid target', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection-count', count: 0 });
    expect(ui.$('#scan-btn').disabled).toBe(false);
  });

  it('says what the next scan will cover', () => {
    // Scanning is a deliberate click, so the button has to name its target.
    ui = loadUI(UI);
    ui.receive({ type: 'selection-count', count: 0 });
    expect(ui.$('#rescan-label').textContent.trim()).toBe('Scan file');

    ui.receive({ type: 'selection-count', count: 2 });
    expect(ui.$('#rescan-label').textContent.trim()).toBe('Scan selection');

    // The DS icon has to survive the relabelling — the parity contract requires it.
    expect(ui.$('#rescan-btn').querySelector('use').getAttribute('href')).toBe('#icon-update');
  });

  it('does not scan just because the selection changed', async () => {
    ui = loadUI(UI);
    ui.sent.length = 0;
    ui.receive({ type: 'selection-count', count: 2 });
    await painted();

    expect(ui.sentOf('request-scan')).toEqual([]);
  });

  it('scans on demand when the button is clicked', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection-count', count: 2 });
    ui.click('#rescan-btn');

    expect(ui.sentOf('request-scan').length).toBe(1);
  });
});

describe('tokens-to-ink UI — scan results', () => {
  it('lists the colours the plugin found', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    expect(ui.$('#color-body').textContent).toContain('brand/primary');
  });

  it('shows the print values in editable boxes', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    // The whole point: a screen colour paired with a printable one, ready to adjust.
    const boxes = ui.$$('#color-body .cmyk-box').map((el) => el.value);
    expect(boxes).toEqual(['0', '100', '100', '0']);
  });

  it('treats a selection of only hardcoded colours as nothing to pair', async () => {
    // Raw colours have no variable to attach print values to, so the table stays
    // empty rather than showing rows nobody can act on.
    ui = loadUI(UI);
    ui.receive(scanResults([
      colour({ source: 'raw', colorVarId: null, name: '#0000FF', hex: '#0000FF' }),
    ]));
    await painted();

    expect(ui.$$('#color-body tr')).toEqual([]);
    expect(ui.$('#no-colors-state').style.display).toBe('flex');
    // Nothing to export either.
    expect(ui.$('#export-picker').style.display).toBe('none');
  });

  it('reveals the results panel once there is something to show', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    expect(ui.$('#results-ui').style.display).not.toBe('none');
  });

  it('lists the file-wide colours but offers no export when nothing is selected', async () => {
    ui = loadUI(UI);
    ui.receive({ ...scanResults(), sourceNodes: [] });
    await painted();

    expect(ui.$('#color-body').textContent).toContain('brand/primary');
    // Nothing on canvas to render, so exporting would be meaningless.
    expect(ui.$('#export-picker').style.display).toBe('none');
    expect(ui.$('#source-chips').textContent).toMatch(/all color variables/i);
  });

  it('explains an empty file differently from an empty selection', async () => {
    ui = loadUI(UI);
    ui.receive({ ...scanResults([]), sourceNodes: [] });
    await painted();

    expect(ui.$('#no-colors-state').style.display).toBe('flex');
    expect(ui.$('#no-colors-state').textContent).toContain('This file has no color variables');
  });

  it('surfaces a scan error', async () => {
    ui = loadUI(UI);
    ui.receive({ type: 'error', message: 'Scan error: boom' });
    await painted();

    expect(ui.document.body.textContent).toContain('boom');
  });
});

describe('tokens-to-ink UI — export', () => {
  it('asks the plugin for a PDF when that format is chosen', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    ui.click('#export-btn');      // opens the format picker
    ui.click('#export-pdf-btn');  // chooses PDF

    expect(ui.sentOf('export-request')[0]).toMatchObject({ format: 'pdf' });
  });

  it('asks the plugin for a raster export when that format is chosen', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    ui.click('#export-btn');
    ui.click('#export-tiff-btn');

    expect(ui.sentOf('export-request')[0]).toMatchObject({ format: 'tiff' });
  });

  it('reports how many frames are queued', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();
    ui.receive({ type: 'export-ready', count: 3, format: 'pdf' });
    await painted();

    expect(ui.document.body.textContent).toMatch(/3/);
  });
});
