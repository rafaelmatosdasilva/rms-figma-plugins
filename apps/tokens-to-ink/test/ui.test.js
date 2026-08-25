import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadUI } from '@rms/test-utils';

const UI = fileURLToPath(new URL('../ui.html', import.meta.url));

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

/** Let the UI's requestAnimationFrame work settle. */
const painted = () => new Promise((r) => setTimeout(r, 50));
// Export is now an inline view; pick a format via its radio.
const pickFmt = (u, f) => { const r = u.$(`#fmt-${f}`); r.checked = true; r.dispatchEvent(new u.window.Event('change')); };

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
    expect(ui.$('#view-tabs-row').style.display).toBe('none');
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
    expect(ui.$('#view-tabs-row').style.display).toBe('none');
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
    expect(ui.$('#view-tabs-row').style.display).toBe('none');
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

    ui.window.__showExportView();     // open the inline Export view (PDF is the default)
    ui.click('#export-confirm-btn');

    expect(ui.sentOf('export-request')[0]).toMatchObject({ format: 'pdf' });
  });

  it('asks the plugin for a raster export when that format is chosen', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    ui.window.__showExportView();
    const t = ui.$('#fmt-tiff'); t.checked = true; t.dispatchEvent(new ui.window.Event('change'));
    ui.click('#export-confirm-btn');

    expect(ui.sentOf('export-request')[0]).toMatchObject({ format: 'tiff' });
  });

  it('shows marks/bleeds for PDF and a resolution-only panel for TIFF', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    ui.window.__showExportView();
    expect(ui.$('#card-marks').hidden).toBe(false);  // marks/bleed card
    expect(ui.$('#card-tiff').hidden).toBe(true);

    const t = ui.$('#fmt-tiff'); t.checked = true; t.dispatchEvent(new ui.window.Event('change'));
    expect(ui.$('#card-marks').hidden).toBe(false);  // marks/bleed stays for TIFF too
    expect(ui.$('#card-output').hidden).toBe(true);  // PDF-only Output card gone
    expect(ui.$('#card-tiff').hidden).toBe(false);   // resolution (raster) card shown
  });

  it('sends the chosen TIFF export resolution with the request', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();

    ui.window.__showExportView();
    const tf = ui.$('#fmt-tiff'); tf.checked = true; tf.dispatchEvent(new ui.window.Event('change'));
    const res = ui.$('#tiff-dpi-input');
    res.value = '600';
    res.dispatchEvent(new ui.window.Event('input'));
    ui.click('#export-confirm-btn');

    expect(ui.sentOf('export-request')[0]).toMatchObject({ format: 'tiff', tiffDpi: 600 });
  });

  it('writes the chosen resolution into the TIFF XResolution tag', async () => {
    ui = loadUI(UI);
    // 2×2 CMYK+alpha buffer (5 bytes/px); uncompressed so the tag offsets are stable.
    const px = new Uint8Array(2 * 2 * 5);
    const tiff = await ui.window.buildCmykaTiff(px, 2, 2, 600, false);
    const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    // Little-endian TIFF: walk the IFD, find XResolution (tag 282), read its RATIONAL.
    const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true);
    let xres = null;
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (dv.getUint16(e, true) === 282) { const off = dv.getUint32(e + 8, true); xres = dv.getUint32(off, true); }
    }
    expect(xres).toBe(600);
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

describe('tokens-to-ink UI — save as default', () => {
  const openExport = async (u) => { u.receive(scanResults()); await painted(); u.window.__showExportView(); };
  const settingsMsg = (over = {}) => ({
    type: 'settings', cropMarks: false, regMarks: false, colorBars: false, preserveSpot: true,
    pdfx: true, pageInfo: false, bleedOn: false, bleedMm: 3, downsample: false, downsampleDpi: 300,
    tiffDpi: 300, tiffZip: true, ...over,
  });

  it('disables the button while options equal the saved defaults, enables on change', async () => {
    ui = loadUI(UI);
    await openExport(ui);
    ui.receive(settingsMsg());
    await painted();
    expect(ui.$('#export-savedefault-btn').disabled).toBe(true);   // nothing to save yet
    const t = ui.$('#cropmarks-toggle'); t.checked = true; t.dispatchEvent(new ui.window.Event('change'));
    expect(ui.$('#export-savedefault-btn').disabled).toBe(false);  // changed → can save
  });

  it('confirms with a toast and re-disables after saving', async () => {
    ui = loadUI(UI);
    await openExport(ui);
    ui.receive(settingsMsg());
    await painted();
    const t = ui.$('#regmarks-toggle'); t.checked = true; t.dispatchEvent(new ui.window.Event('change'));
    ui.click('#export-savedefault-btn');
    expect(ui.$('#toast-container').textContent).toContain('saved as default');
    expect(ui.$('#export-savedefault-btn').disabled).toBe(true);   // current options are now the defaults
    expect(ui.sentOf('save-settings').pop()).toMatchObject({ regMarks: true });
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

  it('names the frames whose images stayed RGB, not just a count', async () => {
    ui = loadUI(UI);
    ui.window.downloadFile = () => {};

    // Stand in for the real PDF conversion, reporting per-frame how many images
    // it couldn't convert (the count the export handler reads after each frame).
    const unconverted = { Logo: 2, Banner: 0, Hero: 1 };
    const order = ['Logo', 'Banner', 'Hero'];
    let call = 0;
    ui.window.convertPdfToCmyk = async () => {
      ui.window._lastPdfImagesUnconverted = unconverted[order[call++]] ?? 0;
      return new Uint8Array([1]);
    };

    ui.receive({ type: 'export-batch-start', total: order.length, format: 'pdf' });
    for (let i = 0; i < order.length; i++) {
      await ui.receive({
        type: 'export-data', format: 'pdf', pdfBytes: new Uint8Array([1]),
        colorLookup: {}, frameName: order[i], index: i, total: order.length,
      });
    }
    await painted();

    const toast = ui.$('#toast-container').textContent;
    expect(toast).toContain('Logo');       // 2 images couldn't convert
    expect(toast).toContain('Hero');       // 1 image couldn't convert
    expect(toast).not.toContain('Banner'); // clean frame is never named
    expect(toast).toContain('3 images');   // 2 + 1 across the batch
  });
});

describe('tokens-to-ink UI — export filename collisions', () => {
  // A multi-file batch with no folder handle collects files for a ZIP, so stubbing
  // _buildZip lets us read the exact filenames each item was written under.
  async function exportNames(names) {
    ui = loadUI(UI);
    ui.window.convertPdfToCmyk = async () => new Uint8Array([1]);
    ui.window.downloadFile = () => {};
    let captured = null;
    ui.window._buildZip = (files) => { captured = files.map((f) => f.name); return new Uint8Array([0]); };

    ui.receive({ type: 'export-batch-start', total: names.length, format: 'pdf' });
    for (let i = 0; i < names.length; i++) {
      await ui.receive({
        type: 'export-data', format: 'pdf', pdfBytes: new Uint8Array([1]),
        colorLookup: {}, frameName: names[i], index: i, total: names.length,
      });
    }
    await painted();
    return captured;
  }

  it('gives same-named items distinct filenames instead of overwriting', async () => {
    expect(await exportNames(['Logo', 'Logo', 'Logo'])).toEqual([
      'Logo_CMYK.pdf', 'Logo_CMYK-2.pdf', 'Logo_CMYK-3.pdf',
    ]);
  });

  it('leaves distinct names untouched', async () => {
    expect(await exportNames(['Alpha', 'Beta'])).toEqual(['Alpha_CMYK.pdf', 'Beta_CMYK.pdf']);
  });
});

describe('tokens-to-ink UI — crop marks option', () => {
  it('is off by default and passes crop-marks, bleed and downsample to the PDF converter', async () => {
    ui = loadUI(UI);
    let captured = null;
    ui.window.convertPdfToCmyk = async (_pdf, _lookup, opts) => { captured = opts; return new Uint8Array([1]); };
    ui.window.downloadFile = () => {};

    const marks = ui.$('#cropmarks-toggle');
    const bleedOn = ui.$('#bleed-toggle');
    const down = ui.$('#downsample-toggle');
    const bleed = ui.$('#bleed-input');
    expect(marks.checked).toBe(false);   // every print option off by default
    expect(bleedOn.checked).toBe(false);
    expect(down.checked).toBe(false);
    expect(bleed.disabled).toBe(true);   // the amount is inert until Bleed is turned on

    marks.checked = true; marks.dispatchEvent(new ui.window.Event('change'));
    bleedOn.checked = true; bleedOn.dispatchEvent(new ui.window.Event('change'));
    expect(bleed.disabled).toBe(false);  // turning Bleed on enables its amount field
    bleed.value = '5'; bleed.dispatchEvent(new ui.window.Event('input'));
    down.checked = true; down.dispatchEvent(new ui.window.Event('change'));

    ui.receive({ type: 'export-batch-start', total: 1, format: 'pdf' });
    await ui.receive({
      type: 'export-data', format: 'pdf', pdfBytes: new Uint8Array([1]),
      colorLookup: {}, frameName: 'Card', index: 0, total: 1,
    });
    await painted();

    expect(captured).toBeTruthy();
    expect(captured.cropMarks).toBe(true);
    expect(captured.bleedPt).toBeCloseTo(5 * 72 / 25.4, 3); // 5 mm → points
    expect(captured.downsample).toBe(true);
  });

  it('sends no bleed when the Bleed checkbox is off, even with an amount typed', async () => {
    ui = loadUI(UI);
    let captured = null;
    ui.window.convertPdfToCmyk = async (_pdf, _lookup, opts) => { captured = opts; return new Uint8Array([1]); };
    ui.window.downloadFile = () => {};

    const marks = ui.$('#cropmarks-toggle');
    marks.checked = true; marks.dispatchEvent(new ui.window.Event('change'));
    const bleed = ui.$('#bleed-input');           // amount present, but Bleed left off
    bleed.value = '4'; bleed.dispatchEvent(new ui.window.Event('input'));

    ui.receive({ type: 'export-batch-start', total: 1, format: 'pdf' });
    await ui.receive({
      type: 'export-data', format: 'pdf', pdfBytes: new Uint8Array([1]),
      colorLookup: {}, frameName: 'Card', index: 0, total: 1,
    });
    await painted();

    expect(captured.cropMarks).toBe(true);
    expect(captured.bleedPt).toBe(0); // Bleed checkbox off → no bleed margin
  });

  it('names the confirm button after the chosen format', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();
    ui.window.__showExportView();

    expect(ui.$('#export-confirm-label').textContent).toBe('Export PDF');
    pickFmt(ui, 'tiff');
    expect(ui.$('#export-confirm-label').textContent).toBe('Export TIFF');
    pickFmt(ui, 'pdf');
    expect(ui.$('#export-confirm-label').textContent).toBe('Export PDF');
  });

  it('swaps Output↔Raster by format but keeps marks/bleed visible for both', async () => {
    ui = loadUI(UI);
    ui.receive(scanResults());
    await painted();
    ui.window.__showExportView();

    expect(ui.$('#card-marks').hidden).toBe(false);    // PDF is the default format
    expect(ui.$('#card-tiff').hidden).toBe(true);

    pickFmt(ui, 'tiff');
    expect(ui.$('#card-marks').hidden).toBe(false);     // marks/bleed applies to TIFF too
    expect(ui.$('#card-tiff').hidden).toBe(false);      // raster card shown alongside

    pickFmt(ui, 'pdf');
    expect(ui.$('#card-marks').hidden).toBe(false);     // still there on the way back
    expect(ui.$('#card-tiff').hidden).toBe(true);
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
