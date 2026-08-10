import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadUI } from '@rms/test-utils';

const UI = fileURLToPath(new URL('../ui.html', import.meta.url));

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

// The export button opens the DS overflow (PDF/TIFF); picking a format opens the modal.
const openModal    = (u) => { u.click('#export-btn'); u.click('#export-pdf-item'); };
const openModalTiff = (u) => { u.click('#export-btn'); u.click('#export-tiff-item'); };
const enableDownsample = (u) => { const t = u.$('#downsample-toggle'); t.checked = true; t.dispatchEvent(new u.window.Event('change')); };
// The low-res image list arrives on a preflight-images message.
const imagesMsg = (over = {}) => ({ type: 'preflight-images', target: 300, images: [], ...over });

describe('tokens-to-ink UI — export pre-flight', () => {
  it('shows the low-res image list only once downsample is on, and focuses on click', () => {
    ui = loadUI(UI);
    openModal(ui);
    const imgs = [{ id: 'i1', name: 'hero.jpg', meta: '1200×1200 px · 210 dpi' }];

    // Off by default → hidden even though images were sent.
    ui.receive(imagesMsg({ images: imgs }));
    expect(ui.$('#preflight-images-section').hidden).toBe(true);

    // Turn it on → shown, with the target dpi in the header.
    enableDownsample(ui);
    ui.receive(imagesMsg({ images: imgs }));
    expect(ui.$('#preflight-images-section').hidden).toBe(false);
    const rows = ui.$$('#preflight-images .preflight-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('hero.jpg');
    expect(rows[0].textContent).toContain('210 dpi');
    expect(ui.$('#preflight-images-header').textContent).toMatch(/Images under 300 dpi/);

    const focusBtn = rows[0].querySelector('.preflight-focus-btn');
    expect(focusBtn.getAttribute('data-tip')).toBe('Focus in canvas');
    ui.click(focusBtn);
    expect(ui.sentOf('focus-node').pop()).toMatchObject({ type: 'focus-node', nodeId: 'i1' });
    expect(ui.errors).toEqual([]);
  });

  it('hides the image list for TIFF even with downsample on (it does not apply)', () => {
    ui = loadUI(UI);
    openModal(ui);
    enableDownsample(ui);
    openModalTiff(ui);   // re-pick TIFF from the format overflow
    ui.receive(imagesMsg({ hasImages: true, images: [{ id: 'i1', name: 'hero', meta: 'x' }] }));
    expect(ui.$('#preflight-images-section').hidden).toBe(true);
    expect(ui.$('#tiff-panel').hidden).toBe(false);   // TIFF shows the resolution panel…
    expect(ui.$('#export-tabs').hidden).toBe(true);   // …and never the tabs
  });

  it('reveals the Image-quality tab only when the selection has images', () => {
    ui = loadUI(UI);
    openModal(ui);
    // No images → no segmented control, just the marks/bleeds group.
    ui.receive(imagesMsg({ hasImages: false, images: [] }));
    expect(ui.$('#export-tabs').hidden).toBe(true);
    expect(ui.$('#tab-marks').hidden).toBe(false);

    // Images present → the "Marks and bleeds" / "Image quality" control appears.
    ui.receive(imagesMsg({ hasImages: true, images: [] }));
    expect(ui.$('#export-tabs').hidden).toBe(false);
  });

  it('hides the image section when the list is empty (no warning if nothing is below)', () => {
    ui = loadUI(UI);
    openModal(ui);
    enableDownsample(ui);
    ui.receive(imagesMsg({ images: [] }));
    expect(ui.$('#preflight-images-section').hidden).toBe(true);
  });

  it('clears the warning immediately when downsample is deselected', () => {
    ui = loadUI(UI);
    openModal(ui);
    enableDownsample(ui);
    ui.receive(imagesMsg({ images: [{ id: 'i1', name: 'hero', meta: 'x' }] }));
    expect(ui.$('#preflight-images-section').hidden).toBe(false);

    const t = ui.$('#downsample-toggle');
    t.checked = false; t.dispatchEvent(new ui.window.Event('change'));
    expect(ui.$('#preflight-images-section').hidden).toBe(true);   // gone without a new scan
    expect(ui.$('#preflight-images').innerHTML).toBe('');
  });

  it('shows the header for the current dpi target', () => {
    ui = loadUI(UI);
    openModal(ui);
    enableDownsample(ui);
    ui.receive(imagesMsg({ target: 350, images: [{ id: 'i1', name: 'hero', meta: 'x' }] }));
    expect(ui.$('#preflight-images-header').textContent).toMatch(/Images under 350 dpi/);
  });

  it('re-scans against the new threshold when the dpi target changes', async () => {
    ui = loadUI(UI);
    openModal(ui);
    enableDownsample(ui);
    const before = ui.sentOf('preflight-request').length;
    const dpi = ui.$('#dpi-input');
    dpi.value = '150'; dpi.dispatchEvent(new ui.window.Event('input'));
    await new Promise((r) => setTimeout(r, 300));   // clear the input debounce
    const reqs = ui.sentOf('preflight-request');
    expect(reqs.length).toBeGreaterThan(before);
    expect(reqs.pop()).toMatchObject({ dpi: 150 });
  });

  it('requests a scan when the modal opens', () => {
    ui = loadUI(UI);
    openModal(ui);
    expect(ui.sentOf('preflight-request').length).toBeGreaterThan(0);
    expect(ui.sentOf('preflight-request').pop()).toMatchObject({ dpi: 300 });
  });

  it('clears the warning on reopen — a new selection never shows the old images', () => {
    ui = loadUI(UI);
    openModal(ui);
    enableDownsample(ui);
    ui.receive(imagesMsg({ images: [{ id: 'oldimg', name: 'old.jpg', meta: '100×100 px · 50 dpi' }] }));
    expect(ui.$('#preflight-images-section').hidden).toBe(false);

    // Reopen (e.g. after scanning a different selection) → the list is empty immediately,
    // BEFORE any new scan result arrives.
    openModal(ui);
    expect(ui.$('#preflight-images').innerHTML).toBe('');
    expect(ui.$('#preflight-images-section').hidden).toBe(true);

    // The fresh scan populates with the new selection's images.
    ui.receive(imagesMsg({ images: [{ id: 'newimg', name: 'new.jpg', meta: '120×120 px · 60 dpi' }] }));
    const rows = ui.$$('#preflight-images .preflight-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('new.jpg');
  });

  it('lists images that will stay RGB (independent of downsample) and focuses on click', () => {
    ui = loadUI(UI);
    openModal(ui);
    const bad = [{ id: 'b1', name: 'logo.jpg', meta: 'CMYK JPEG' }];

    // Shown even with downsample OFF — the CMYK conversion always runs.
    ui.receive(imagesMsg({ hasImages: true, unconvertible: bad }));
    expect(ui.$('#preflight-cmyk-section').hidden).toBe(false);
    const rows = ui.$$('#preflight-cmyk .preflight-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('logo.jpg');
    expect(rows[0].textContent).toContain('CMYK JPEG');

    ui.click(rows[0].querySelector('.preflight-focus-btn'));
    expect(ui.sentOf('focus-node').pop()).toMatchObject({ type: 'focus-node', nodeId: 'b1' });
    expect(ui.errors).toEqual([]);
  });

  it('hides the RGB-warning list when none are reported, and for TIFF', () => {
    ui = loadUI(UI);
    openModal(ui);
    ui.receive(imagesMsg({ hasImages: true, unconvertible: [] }));
    expect(ui.$('#preflight-cmyk-section').hidden).toBe(true);

    openModalTiff(ui);   // TIFF has no CMYK-vector conversion
    ui.receive(imagesMsg({ hasImages: true, unconvertible: [{ id: 'b1', name: 'logo.jpg', meta: 'CMYK JPEG' }] }));
    expect(ui.$('#preflight-cmyk-section').hidden).toBe(true);
  });

  it('escapes a malicious layer name — it cannot inject markup', () => {
    ui = loadUI(UI);
    openModal(ui);
    enableDownsample(ui);
    ui.receive(imagesMsg({ images: [{ id: 'x', name: '<img src=x onerror="globalThis.__pf=1">', meta: '10×10 px · 5 dpi' }] }));
    const list = ui.$('#preflight-images');
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror=');
    expect(ui.window.__pf).toBeUndefined();
  });
});
