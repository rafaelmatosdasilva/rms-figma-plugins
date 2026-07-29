import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Load a plugin's BUILT ui.html into jsdom and drive it the way Figma does.
 *
 * The UI is a plain page with inline script: it talks to the plugin by posting to
 * `parent` and listens on `window.onmessage`. So a test can stub `parent`, hand it
 * real backend payloads, and assert the DOM that comes out — no browser needed.
 *
 * Returns:
 *   window, document — the live page
 *   sent             — every pluginMessage the UI posted, in order
 *   sentOf(type)     — those of one type
 *   receive(msg)     — deliver a message from the plugin (synchronous)
 *   $ / $$           — querySelector / querySelectorAll shorthands
 *   text(sel)        — trimmed textContent of the first match
 */
export function loadUI(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const sent = [];

  // Without this, a thrown error inside the UI is swallowed and the test just sees
  // an empty container — the failure looks like a missing feature instead of a bug.
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  virtualConsole.on('error', (...args) => errors.push(new Error(args.join(' '))));

  const dom = new JSDOM(html, {
    virtualConsole,
    runScripts: 'dangerously',
    pretendToBeVisual: true, // gives requestAnimationFrame
    beforeParse(window) {
      // The UI posts to `parent`; in Figma that's the plugin host. Capture instead.
      Object.defineProperty(window, 'parent', {
        configurable: true,
        value: { postMessage: (msg) => { sent.push(msg && msg.pluginMessage ? msg.pluginMessage : msg); } },
      });

      // jsdom has no layout engine, so anything geometry-driven is stubbed rather
      // than asserted on — these tests are about wiring and content, not pixels.
      if (!window.ResizeObserver) {
        window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      }
      if (!window.matchMedia) {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      }
      window.Element.prototype.scrollTo = function () {};
      window.Element.prototype.scrollIntoView = function () {};
    },
  });

  const { window } = dom;
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];

  return {
    dom,
    window,
    document: window.document,
    sent,
    /** Anything the UI threw or logged as an error. Assert this is empty. */
    errors,
    sentOf: (type) => sent.filter((m) => m && m.type === type),
    /**
     * Deliver a plugin → UI message.
     *
     * The handler is invoked directly rather than through dispatchEvent: jsdom
     * swallows exceptions thrown inside a listener, so a broken render would show
     * up as an empty container instead of a failure. Calling it directly lets the
     * error reach the test. All three UIs assign `window.onmessage`, so this is
     * how they actually receive messages.
     */
    receive(pluginMessage) {
      const handler = window.onmessage;
      if (typeof handler !== 'function') {
        throw new Error('receive: the UI never installed a window.onmessage handler');
      }
      return handler.call(window, { data: { pluginMessage } });
    },
    $,
    $$,
    text: (sel) => { const el = $(sel); return el ? el.textContent.trim() : null; },
    /** Click an element and let any handler run. */
    click(selOrEl) {
      const el = typeof selOrEl === 'string' ? $(selOrEl) : selOrEl;
      if (!el) throw new Error(`click: no element for ${selOrEl}`);
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
      return el;
    },
    close() { window.close(); },
  };
}
