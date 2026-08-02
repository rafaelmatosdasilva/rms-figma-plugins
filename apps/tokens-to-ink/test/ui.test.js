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

  it('opens straight into the results view, never a "select something" state', () => {
    // The plugin scans on launch, so there is nothing to ask the user for.
    ui = loadUI(UI);
    expect(ui.$('#empty-state')).toBeNull();
    expect(ui.$('#results-ui').style.display).toBe('flex');
    // ...but nothing is exportable until a scan says what the artwork was.
    expect(ui.$('#export-picker').style.display).toBe('none');
  });

  it('lets you scan with nothing selected — the whole file is a valid target', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection-count', count: 0 });
    expect(ui.$('#rescan-btn').disabled).toBe(false);
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

  it('names the same target while scanning as the button did', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'selection-count', count: 0 });
    ui.receive({ type: 'scan-started' });
    expect(ui.$('.progress-msg.progress-scan').textContent).toContain('Scanning file…');

    ui.receive({ type: 'selection-count', count: 2 });
    ui.receive({ type: 'scan-started' });
    expect(ui.$('.progress-msg.progress-scan').textContent).toContain('Scanning selection…');
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

describe('tokens-to-ink UI — toast safety (shared base)', () => {
  it('escapes HTML in a toast, so a document name cannot run code', () => {
    ui = loadUI(UI);
    const evil = '<img src=x onerror="globalThis.__xss=1">';
    ui.window.showToast(evil, { error: true });

    const container = ui.$('#toast-container');
    // The message is shown as text, never parsed into a live element.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(evil);
    expect(ui.window.__xss).toBeUndefined();
  });
});

describe('tokens-to-ink UI — export failure reporting', () => {
  it('reports earlier failures even when the batch ends on a success', async () => {
    ui = loadUI(UI);
    // Avoid the real PDF conversion and the browser download in jsdom.
    ui.window.convertPdfToCmyk = async () => new Uint8Array([1, 2, 3]);
    ui.window.downloadFile = () => {};

    // A batch of two: frame 0 fails, frame 1 succeeds and is the last one.
    ui.receive({ type: 'export-batch-start', total: 2, format: 'pdf' });
    ui.receive({ type: 'export-item-error', frameName: 'Poster A', message: 'too big', index: 0, total: 2 });
    await ui.receive({
      type: 'export-data', format: 'pdf', pdfBytes: new Uint8Array([1]),
      colorLookup: {}, frameName: 'Poster B', index: 1, total: 2,
    });
    await painted();

    // A batch that finishes on a success must still surface the frame that failed.
    expect(ui.$('#toast-container').textContent).toContain('Poster A');
  });
});

describe('tokens-to-ink UI — XSS in the results table', () => {
  it('escapes a malicious layer name and token name', async () => {
    ui = loadUI(UI);
    const evil = '<img src=x onerror="globalThis.__xss2=1">';
    ui.receive({
      type: 'scan-results',
      data: [colour({ name: evil })],   // token name from the document
      sourceNodes: [{ id: 'f1', name: evil }], // layer name from the document
      hasExternalVars: false, externalLibrary: null,
      summary: { totalColors: 1, withCmykPairs: 0 },
    });
    await painted();

    // No live element was created from either name.
    expect(ui.document.querySelector('#color-body img')).toBeNull();
    expect(ui.document.querySelector('#source-chips img')).toBeNull();
    expect(ui.window.__xss2).toBeUndefined();
    // The names still show, as literal text.
    expect(ui.$('#color-body').textContent).toContain(evil);
  });
});
