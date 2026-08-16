import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, loadUI, makePage, makeNode } from '@rms/test-utils';

const CODE = fileURLToPath(new URL('../src/code.js', import.meta.url));
const UI = fileURLToPath(new URL('../ui.html', import.meta.url));

const imageFill = (hash) => ({ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' });

// An A4 frame with one 800×540 px image placed across 595×400 pt → ~97 dpi (below 300).
function scene() {
  const photo = makeNode('RECTANGLE', { id: 'photo', name: 'Photo', width: 595, height: 400, fills: [imageFill('low')] });
  const frame = makeNode('FRAME', { id: 'flyer', name: 'Flyer', width: 595, height: 842 });
  frame.appendChild(photo);
  const page = makePage('Page 1');
  page.appendChild(frame);
  page.selection = [frame];
  return { pages: [page], images: { low: { width: 800, height: 540 } } };
}

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

describe('tokens-to-ink — preflight end-to-end (real code.js → real UI)', () => {
  it('a low-res image scanned by code.js renders in the export image list', async () => {
    // 1) The real backend produces the message for a low-res selection.
    const { send, postedOf } = await loadPlugin(CODE, scene());
    await send({ type: 'preflight-request', dpi: 300, scanImages: true });
    const imagesMsg = postedOf('preflight-images').pop();
    expect(imagesMsg.images).toHaveLength(1);

    // 2) Feed that EXACT message into the real UI, mimicking the plugin's flow.
    ui = loadUI(UI);
    ui.window.__showExportView();
    const t = ui.$('#downsample-toggle');
    t.checked = true; t.dispatchEvent(new ui.window.Event('change'));
    ui.receive(imagesMsg);

    // The low-res image is shown.
    expect(ui.$('#preflight-images-section').hidden).toBe(false);
    const rows = ui.$$('#preflight-images .preflight-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Photo');
    expect(ui.errors).toEqual([]);
  });
});
