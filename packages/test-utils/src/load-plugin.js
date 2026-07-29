// Loads a plugin backend against a mocked `figma`.
//
// The backends are not testable by importing functions — they export nothing and
// install their router by assigning `figma.ui.onmessage`. They also run side effects
// at import time (figma.showUI, attachWindowResize → clientStorage.getAsync, and in
// some plugins a canvas sweep). So the globals must exist BEFORE the import, and each
// test needs a fresh module instance because module-level state (caches, indexes,
// cancellation flags) is a per-load singleton.

import { vi } from 'vitest';
import { makeFigmaMock } from './figma-mock.js';
import { resetIds } from './nodes.js';

/**
 * @param {string} entry  absolute path (or file URL) of the plugin's src/code.js
 * @param {object} scene  scene description passed to makeFigmaMock
 * @returns {Promise<{figma, posted, send, postedOf, lastOf}>}
 */
export async function loadPlugin(entry, scene = {}) {
  resetIds();
  vi.resetModules();

  const figma = makeFigmaMock(scene);
  globalThis.figma = figma;
  globalThis.__html__ = '<html><body>test</body></html>';

  await import(/* @vite-ignore */ entry);

  const handler = figma.ui.onmessage;
  if (typeof handler !== 'function') {
    throw new Error('Plugin did not install a figma.ui.onmessage handler');
  }

  const posted = figma.ui.postMessage.calls;

  return {
    figma,
    posted,
    /** Send a message to the plugin exactly as the UI would, and await it. */
    send: (msg) => handler(msg),
    /** All messages the plugin posted of a given type. */
    postedOf: (type) => posted.filter((m) => m && m.type === type),
    /** The most recent message of a given type, or undefined. */
    lastOf: (type) => [...posted].reverse().find((m) => m && m.type === type),
  };
}
