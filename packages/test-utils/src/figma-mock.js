// A mock of the `figma` plugin global, covering the union of the APIs the plugin
// backends actually call. Shared by every plugin's tests.
//
// Design notes:
// - The backends install their router with `figma.ui.onmessage = fn`, so `ui` is a
//   plain object and the assigned handler stays readable from the test.
// - Everything a plugin posts is captured in `postMessage.calls` for assertions.
// - Nodes created at runtime (frames, sections, pages) are recorded in `created`,
//   so generated canvas output can be asserted without a real document.
// - clientStorage.getAsync MUST return a promise even when empty: attachWindowResize
//   calls it at import time, before any test code runs.

import { makeNode, makePage } from './nodes.js';

/**
 * @param {object} scene
 *   pages        — array of page nodes (figma.root.children)
 *   variables    — array of local Variable-like objects
 *   collections  — array of local VariableCollection-like objects
 *   remoteVars   — Variable-like objects resolvable by id (and by key via
 *                  importVariableByKeyAsync) but never from getLocalVariablesAsync
 *   remoteColls  — collections for those remote vars
 *   libraryCollections — what teamLibrary reports; omit/empty for the "no linked
 *                  library" path
 *   libraryVariables — { collectionKey: [LibraryVariable] } listed per collection
 *   clientStorage — seed data, e.g. { 'scan-local': cachedScan }
 *   fileKey      — defaults to undefined, mirroring dev plugins where it's blocked
 *   textStyles / paintStyles / effectStyles — local style lists
 */
export function makeFigmaMock(scene = {}) {
  const pages = scene.pages && scene.pages.length ? scene.pages : [makePage('Page 1')];
  const variables = scene.variables || [];
  const collections = scene.collections || [];
  const remoteVars = scene.remoteVars || [];
  const remoteColls = scene.remoteColls || [];

  const byId = new Map();
  for (const v of [...variables, ...remoteVars]) byId.set(v.id, v);
  const collById = new Map();
  for (const c of [...collections, ...remoteColls]) collById.set(c.id, c);

  const nodeById = new Map();
  const indexNode = (n) => {
    nodeById.set(n.id, n);
    for (const child of n.children || []) indexNode(child);
  };
  pages.forEach(indexNode);

  const imported = [];   // keys passed to importVariableByKeyAsync, in order
  const storage = new Map(Object.entries(scene.clientStorage || {}));
  const posted = [];
  const created = { frames: [], sections: [], pages: [], instances: [] };
  const events = {};

  const postMessage = (msg) => { posted.push(msg); };
  postMessage.calls = posted;

  const figma = {
    // ── Lifecycle / chrome ──────────────────────────────────────────────────
    showUI: () => {},
    closePlugin: () => { figma.closed = true; },
    closed: false,
    fileKey: scene.fileKey,
    mixed: Symbol('figma.mixed'),
    openExternal: () => {},
    on: (event, cb) => { (events[event] = events[event] || []).push(cb); },
    emit: (event, ...args) => (events[event] || []).forEach((cb) => cb(...args)),

    ui: {
      postMessage,
      resize: () => {},
      onmessage: null,
    },

    // ── Document ────────────────────────────────────────────────────────────
    root: { children: pages },
    currentPage: pages[0],
    async setCurrentPageAsync(page) { figma.currentPage = page; },
    async loadAllPagesAsync() {},

    async getNodeByIdAsync(id) { return nodeById.get(id) || null; },
    async getStyleByIdAsync(id) { return (scene.stylesById || {})[id] || null; },
    // The manifests declare documentAccess:"dynamic-page", under which Figma REMOVES
    // the synchronous by-id lookups — calling them throws. The mock mirrors that so a
    // regression back to a sync call fails loudly instead of silently passing.
    getNodeById() { throw new Error('In dynamic-page documents, use getNodeByIdAsync instead of getNodeById'); },
    getStyleById() { throw new Error('In dynamic-page documents, use getStyleByIdAsync instead of getStyleById'); },
    async loadFontAsync() {},

    // ── Creation — recorded so tests can assert generated output ────────────
    createFrame() {
      const f = makeNode('FRAME', { name: 'Frame' });
      created.frames.push(f);
      return f;
    },
    createSection() {
      const s = makeNode('SECTION', { name: 'Section' });
      created.sections.push(s);
      return s;
    },
    createPage() {
      const p = makePage('Page');
      created.pages.push(p);
      pages.push(p);
      indexNode(p);
      // Give the page a parent whose children ARE figma.root.children, so
      // page.remove() detaches it from the document the way Figma does. Without
      // this a removed page lingered in root.children and hid cleanup bugs.
      p.parent = { children: pages };
      return p;
    },
    async importComponentByKeyAsync(key) {
      for (const n of nodeById.values()) if (n.key === key) return n;
      return null;
    },

    // Record focus targets so tests can assert focus actually navigated.
    viewport: { scrollAndZoomIntoView: (nodes) => { figma._focused.push(...(nodes || [])); } },

    // ── Variables ───────────────────────────────────────────────────────────
    variables: {
      async getLocalVariablesAsync() { return variables; },
      async getLocalVariableCollectionsAsync() { return collections; },
      async getVariableByIdAsync(id) { return byId.get(id) || null; },
      async getVariableCollectionByIdAsync(id) { return collById.get(id) || null; },
      // Removed under dynamic-page (see getNodeById above) — throw to catch regressions.
      getVariableById() { throw new Error('In dynamic-page documents, use getVariableByIdAsync instead of getVariableById'); },
      getVariableCollectionById() { throw new Error('In dynamic-page documents, use getVariableCollectionByIdAsync instead of getVariableCollectionById'); },
      // Resolves a library variable into this file. Counted so tests can assert
      // callers don't re-import on every refresh. Throws on an unknown key, as
      // the real API does.
      async importVariableByKeyAsync(key) {
        imported.push(key);
        for (const v of byId.values()) if (v.key === key) return v;
        throw new Error(`No variable found for key ${key}`);
      },
    },

    async getLocalTextStylesAsync() { return scene.textStyles || []; },
    async getLocalPaintStylesAsync() { return scene.paintStyles || []; },
    async getLocalEffectStylesAsync() { return scene.effectStyles || []; },

    // ── Storage ─────────────────────────────────────────────────────────────
    clientStorage: {
      async getAsync(key) { return storage.has(key) ? storage.get(key) : undefined; },
      async setAsync(key, value) { storage.set(key, value); },
    },

    // Test-only handles (not part of the real API)
    _focused: [],
    _created: created,
    _storage: storage,
    _nodeById: nodeById,
    _importedVarKeys: imported,
  };

  // teamLibrary is optional: omitting it exercises the "no linked libraries" path,
  // which is exactly the situation that used to hide external tokens.
  if (scene.libraryCollections) {
    figma.teamLibrary = {
      async getAvailableLibraryVariableCollectionsAsync() { return scene.libraryCollections; },
      async getVariablesInLibraryCollectionAsync(key) {
        return (scene.libraryVariables || {})[key] || [];
      },
    };
  }

  return figma;
}

/** A local variable. Alias another by passing `aliasOf`. */
export function makeVar(id, name, opts = {}) {
  const modeId = opts.modeId || 'mode-1';
  const value = opts.aliasOf
    ? { type: 'VARIABLE_ALIAS', id: opts.aliasOf }
    : (opts.value ?? { r: 0.2, g: 0.4, b: 0.8 });
  return {
    id,
    name,
    key: opts.key || `key-${id}`,
    resolvedType: opts.resolvedType || 'COLOR',
    variableCollectionId: opts.collectionId || 'coll-1',
    valuesByMode: { [modeId]: value },
    remote: opts.remote ?? false,
  };
}

/** A variable collection. */
export function makeCollection(id, name, opts = {}) {
  return {
    id,
    name,
    key: opts.key || `ckey-${id}`,
    modes: opts.modes || [{ modeId: opts.modeId || 'mode-1', name: 'Mode 1' }],
    remote: opts.remote ?? false,
  };
}
