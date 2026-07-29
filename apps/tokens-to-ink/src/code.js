// Tokens to Ink
// Scans on launch, then only when asked. With nothing selected it lists every
// colour variable the file can use. Exports as vector PDF or 300 DPI CMYK TIFF.
// Output values (CMYK, Pantone, RAL, Vinyl) are stored as tags in the origin
// color variable's description field, e.g.: [cmyk:0,100,100,0] [pantone:485 C]

import {
  rgbToHex, rgbToCmyk, parseCmykString,
  parseDescTag, setDescTag, removeDescTag,
  collectNodeColors, collectVarIds,
  attachWindowResize,
} from '@rms/core';

figma.showUI(__html__, { width: 600, height: 600 });

const handleResizeMsg = attachWindowResize(figma, { defaultW: 600, defaultH: 600, minW: 320, minH: 200 });

let _exportCancelled = false;
let _exportState = null; // { selection, format, colorLookup } — persists across ack messages
let _scanCancelled = false;

function notifySelectionCount() {
  figma.ui.postMessage({ type: "selection-count", count: figma.currentPage.selection.length });
}

(async () => {
  await figma.loadAllPagesAsync();
  // Selecting something only relabels the scan button — scanning stays a
  // deliberate click, so a stray selection never throws away the current results.
  figma.on("selectionchange", notifySelectionCount);
  figma.on("documentchange", scheduleRescan);
  notifySelectionCount();
  figma.ui.postMessage({ type: "scan-started" });
  runScan();
})();

// ─── Variable value helpers ─────────────────────────────────────────

function getVariableValue(variable) {
  if (!variable || !variable.valuesByMode) return null;
  const keys = Object.keys(variable.valuesByMode);
  return keys.length > 0 ? variable.valuesByMode[keys[0]] : null;
}

async function resolveColorValue(variable, allVariablesById, depth = 0) {
  if (depth > 10) return null;
  const value = getVariableValue(variable);
  if (!value) return null;
  if (value.type === "VARIABLE_ALIAS") {
    let referenced = allVariablesById.get(value.id);
    if (!referenced) {
      try { referenced = await figma.variables.getVariableByIdAsync(value.id); } catch (_) {}
      if (referenced) allVariablesById.set(referenced.id, referenced);
    }
    if (!referenced) return null;
    return resolveColorValue(referenced, allVariablesById, depth + 1);
  }
  if (typeof value.r === "number" && !isNaN(value.r) &&
      typeof value.g === "number" && !isNaN(value.g) &&
      typeof value.b === "number" && !isNaN(value.b)) {
    return value;
  }
  return null;
}

// ─── Color lookup for export ─────────────────────────────────────────

async function buildColorLookup(colorVariables, allVariablesById) {
  const lookup = {};
  for (const cv of colorVariables) {
    const colorValue = await resolveColorValue(cv, allVariablesById);
    if (!colorValue) continue;
    const hex = rgbToHex(colorValue.r, colorValue.g, colorValue.b);
    const cmykStr = parseDescTag(cv.description, "cmyk");
    const manual = cmykStr ? parseCmykString(cmykStr) : null;
    lookup[hex] = manual || rgbToCmyk(colorValue.r, colorValue.g, colorValue.b);
  }
  return lookup;
}

// ─── Result row for one colour variable ──────────────────────────────

async function buildVariableEntry(variable, allVariablesById) {
  const colorValue = await resolveColorValue(variable, allVariablesById);
  if (!colorValue) return null;

  const hex = rgbToHex(colorValue.r, colorValue.g, colorValue.b);
  const desc = variable.description || "";
  const cmykStr = parseDescTag(desc, "cmyk");
  const manualCmyk = cmykStr ? parseCmykString(cmykStr) : null;

  return {
    name: variable.name,
    hex,
    rgb: {
      r: Math.round(colorValue.r * 255),
      g: Math.round(colorValue.g * 255),
      b: Math.round(colorValue.b * 255),
    },
    cmyk: manualCmyk || rgbToCmyk(colorValue.r, colorValue.g, colorValue.b),
    hasCmykVariable: !!manualCmyk,
    colorVarId: variable.id,
    pantone: parseDescTag(desc, "pantone") || null,
    ral: parseDescTag(desc, "ral") || null,
    vinyl: parseDescTag(desc, "vinyl") || null,
    source: "variable",
    isExternal: !!variable.remote,
    collectionId: variable.variableCollectionId,
  };
}

// ─── Node helpers ────────────────────────────────────────────────────

function getPageForNode(node) {
  let p = node;
  while (p && p.type !== "PAGE") p = p.parent;
  return p && p.type === "PAGE" ? p : null;
}

// ─── Scan current selection ──────────────────────────────────────────

let _lastScannedIds = [];
let _allVarsMode = false;   // nothing selected — listing every available colour variable

// Scans overlap — the launch scan can still be in flight when a rescan or an
// edit-triggered refresh starts another. Only the newest one is allowed to report.
let _scanSeq = 0;

async function runScan(fromAuto) {
  const seq = ++_scanSeq;
  try { return await _runScan(fromAuto, seq); } catch (err) {
    if (seq !== _scanSeq) return;
    figma.ui.postMessage({ type: "error", message: "Scan error: " + err.message });
  }
}

async function _runScan(fromAuto, seq) {
  _scanCancelled = false;
  let selection;
  if (fromAuto) {
    if (_allVarsMode) return _scanAllVariables(seq, true);
    const resolved = await Promise.all(
      _lastScannedIds.map(id => figma.getNodeByIdAsync(id).catch(() => null))
    );
    // A newer scan may have started during that await and already repointed
    // _lastScannedIds — writing the stale list back would aim the export at the
    // artwork the user just navigated away from.
    if (seq !== _scanSeq) return;
    selection = resolved.filter(n => n && !n.removed);
    _lastScannedIds = selection.map(n => n.id);
    if (selection.length === 0) return;
  } else {
    selection = Array.from(figma.currentPage.selection);
    if (selection.length === 0) {
      _lastScannedIds = [];
      _allVarsMode = true;
      return _scanAllVariables(seq, false);
    }
    _lastScannedIds = selection.map(n => n.id);
    _allVarsMode = false;
  }
  if (_scanCancelled) return;

  const allVariables = await figma.variables.getLocalVariablesAsync();
  const colorVariables = allVariables.filter((v) => v.resolvedType === "COLOR");

  const allVariablesById = new Map(allVariables.map(v => [v.id, v]));
  const colorVarById = new Map(colorVariables.map(cv => [cv.id, cv]));

  const discoveredIds = new Set();
  for (const node of selection) await collectVarIds(node, discoveredIds, () => _scanCancelled);
  if (_scanCancelled) return;

  // Fetch missing variables in parallel — sequential awaits here were the
  // main cost on large selections.
  const missing = [];
  for (const vid of discoveredIds) if (!colorVarById.has(vid)) missing.push(vid);
  if (missing.length > 0) {
    const fetched = await Promise.all(
      missing.map(id => figma.variables.getVariableByIdAsync(id).catch(() => null))
    );
    for (const v of fetched) {
      if (v && v.resolvedType === "COLOR") {
        colorVarById.set(v.id, v);
        allVariablesById.set(v.id, v);
      }
    }
  }
  if (_scanCancelled) return;

  const colorMap = new Map();
  for (const node of selection) await collectNodeColors(node, colorMap, () => _scanCancelled);
  if (_scanCancelled) return;

  // Resolve all variable entries in parallel.
  const entries = Array.from(colorMap.values());
  const resolved = await Promise.all(entries.map(async (entry) => {
    if (entry.source === "raw") {
      return {
        name: entry.hex,
        hex: entry.hex,
        source: "raw",
        nodeIds: [...new Set(entry.nodeIds)],
      };
    }

    const variable = colorVarById.get(entry.varId)
      || await figma.variables.getVariableByIdAsync(entry.varId).catch(() => null);
    if (!variable) return null;

    if (!allVariablesById.has(variable.id)) allVariablesById.set(variable.id, variable);

    return buildVariableEntry(variable, allVariablesById);
  }));

  const results = resolved.filter(Boolean);

  results.sort((a, b) => {
    if (a.source !== b.source) return a.source === "variable" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  postScanResults(seq, results, selection.map(n => ({ id: n.id, name: n.name })));
}

// ─── Scan every colour variable the file can use (nothing selected) ──
// Local variables plus the ones published by subscribed libraries. There is no
// artwork to export from, so the UI hides the export button for these results.

// Enumerating every library collection and importing each colour variable costs
// one round trip per variable, so it is held for the session. Document edits
// reuse it — only an explicit scan goes back to the library.
let _libColorVarsCache = null;

async function _collectLibraryColorVariables(fromAuto) {
  if (fromAuto && _libColorVarsCache) return _libColorVarsCache;
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    const keys = [];
    for (const coll of collections) {
      if (_scanCancelled) return [];
      const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(coll.key);
      for (const lv of libVars) if (lv.resolvedType === "COLOR") keys.push(lv.key);
    }
    if (_scanCancelled) return [];
    const imported = await Promise.all(
      keys.map(k => figma.variables.importVariableByKeyAsync(k).catch(() => null))
    );
    _libColorVarsCache = imported.filter(v => v && v.resolvedType === "COLOR");
    return _libColorVarsCache;
  } catch (_) {
    return []; // no team-library access in this file — local variables still list fine
  }
}

async function _scanAllVariables(seq, fromAuto) {
  const localVariables = await figma.variables.getLocalVariablesAsync();
  const allVariablesById = new Map(localVariables.map(v => [v.id, v]));
  const colorVariables = localVariables.filter(v => v.resolvedType === "COLOR");
  if (_scanCancelled) return;

  for (const v of await _collectLibraryColorVariables(fromAuto)) {
    if (allVariablesById.has(v.id)) continue;
    allVariablesById.set(v.id, v);
    colorVariables.push(v);
  }
  if (_scanCancelled) return;

  const resolved = await Promise.all(
    colorVariables.map(v => buildVariableEntry(v, allVariablesById))
  );
  if (_scanCancelled) return;

  const results = resolved.filter(Boolean);
  results.sort((a, b) => a.name.localeCompare(b.name));

  postScanResults(seq, results, []);
}

// ─── Publish results + resolve external library names ────────────────

function postScanResults(seq, results, sourceNodes) {
  if (seq !== _scanSeq) return; // a newer scan has already taken over

  const hasExternalVars = results.some(r => r.source === "variable" && r.isExternal);

  figma.ui.postMessage({
    type: "scan-results",
    data: results,
    sourceNodes,
    hasExternalVars,
    externalLibrary: null,
    summary: {
      totalColors: results.length,
      withCmykPairs: results.filter((r) => r.hasCmykVariable).length,
    },
  });

  // Resolve library name per external variable — one teamLibrary fetch, then one
  // collection lookup per *unique* collection. The collection id rides along on
  // the entry, so a file-wide list doesn't refetch every variable it just read.
  if (hasExternalVars) {
    const externalResults = results.filter(r => r.isExternal && r.collectionId);
    (async () => {
      try {
        const libCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        const collectionToLib = new Map(); // collectionId → libraryName
        const libraries = {};             // varId → libraryName

        for (const collId of new Set(externalResults.map(r => r.collectionId))) {
          const coll = await figma.variables.getVariableCollectionByIdAsync(collId).catch(() => null);
          const match = coll ? libCollections.find(lc => lc.key === coll.key) : null;
          collectionToLib.set(collId, match ? match.libraryName : null);
        }
        for (const r of externalResults) {
          const libName = collectionToLib.get(r.collectionId);
          if (libName) libraries[r.colorVarId] = libName;
        }

        figma.ui.postMessage({ type: 'external-vars-resolved', libraries });
      } catch (_) {}
    })();
  }
}

// ─── Auto-update on document changes ─────────────────────────────────

let _autoScanTimer = null;

function scheduleRescan() {
  if (_lastScannedIds.length === 0 && !_allVarsMode) return;
  if (_autoScanTimer) clearTimeout(_autoScanTimer);
  _autoScanTimer = setTimeout(() => {
    _autoScanTimer = null;
    runScan(true);
  }, 400);
}

// ─── Export one frame, then wait for UI ack before proceeding ────────
// Each call handles exactly one frame. The UI responds with export-frame-ack
// carrying the next index, which triggers another call via the message handler.
// This keeps code.js from awaiting inside the onmessage handler (which would
// prevent Figma from delivering subsequent messages).

async function _exportOneFrame(i) {
  if (!_exportState || _exportCancelled) return;
  const { selection, format, colorLookup } = _exportState;
  if (i >= selection.length) return;

  const node = selection[i];
  try {
    if (format === "pdf") {
      const pdfBytes = await node.exportAsync({ format: "PDF" });
      if (_exportCancelled) return;
      figma.ui.postMessage({
        type: "export-data", format: "pdf",
        pdfBytes: Array.from(pdfBytes),
        colorLookup, frameName: node.name, index: i, total: selection.length,
      });
    } else {
      const dpiScale = 300 / 72;
      const pngBytes = await node.exportAsync({
        format: "PNG", constraint: { type: "SCALE", value: dpiScale },
      });
      if (_exportCancelled) return;
      figma.ui.postMessage({
        type: "export-data", format: "tiff",
        pngBytes: Array.from(pngBytes),
        width: Math.round(node.width * dpiScale),
        height: Math.round(node.height * dpiScale),
        colorLookup, frameName: node.name, index: i, total: selection.length,
      });
    }
  } catch (err) {
    if (_exportCancelled) return;
    figma.ui.postMessage({
      type: "export-item-error",
      frameName: node.name, message: (err && err.message) || String(err), index: i, total: selection.length,
    });
  }
}

// ─── Message handlers ────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {

  if (await handleResizeMsg(msg)) return;

  if (msg.type === "get-saved-height") {
    const savedSize = await figma.clientStorage.getAsync('windowSize');
    if (savedSize && savedSize.h) {
      figma.ui.postMessage({ type: 'restore-height', height: savedSize.h });
    }
    return;
  }

  if (msg.type === "cancel-export") {
    _exportCancelled = true;
    _exportState = null;
    return;
  }

  if (msg.type === "cancel-scan") {
    _scanCancelled = true;
    return;
  }

  // UI finished processing one frame — export the next one.
  if (msg.type === "export-frame-ack") {
    if (!_exportState || _exportCancelled) return;
    await _exportOneFrame(msg.nextIndex);
    return;
  }

  // Step 1: UI requests export → resolve nodes + colorLookup, reply with real count.
  if (msg.type === "export-request") {
    _exportCancelled = false;
    _exportState = null;
    const EXPORTABLE = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "SECTION"]);

    let selection;
    if (_lastScannedIds.length > 0) {
      const resolved = await Promise.all(
        _lastScannedIds.map(id => figma.getNodeByIdAsync(id).catch(() => null))
      );
      selection = resolved.filter(n => n && !n.removed && EXPORTABLE.has(n.type));
    } else {
      selection = Array.from(figma.currentPage.selection).filter(n => EXPORTABLE.has(n.type));
    }

    if (selection.length === 0) {
      figma.ui.postMessage({ type: "error", message: "Please select at least one frame or component." });
      return;
    }

    const format = msg.format;
    const allVariables = await figma.variables.getLocalVariablesAsync();
    const colorVariables = allVariables.filter((v) => v.resolvedType === "COLOR");
    const allVariablesById = new Map(allVariables.map(v => [v.id, v]));
    const colorLookup = await buildColorLookup(colorVariables, allVariablesById);

    _exportState = { selection, format, colorLookup };
    figma.ui.postMessage({ type: "export-ready", count: selection.length, format });
    return;
  }

  // Step 2: UI confirmed picker (or skipped it) — start the actual export.
  if (msg.type === "export-frames") {
    if (!_exportState || _exportCancelled) return;
    figma.ui.postMessage({ type: "export-batch-start", total: _exportState.selection.length, format: _exportState.format });
    await _exportOneFrame(0);
    return;
  }

  if (msg.type === "update-cmyk-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = setDescTag(v.description, "cmyk", msg.cmykValue);
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to update CMYK: " + err.message }); }
    runScan(true); return;
  }
  if (msg.type === "delete-cmyk-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = removeDescTag(v.description, "cmyk");
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to remove CMYK: " + err.message }); }
    runScan(true); return;
  }
  if (msg.type === "update-pantone-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = setDescTag(v.description, "pantone", msg.pantoneValue);
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to update Pantone: " + err.message }); }
    runScan(true); return;
  }
  if (msg.type === "delete-pantone-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = removeDescTag(v.description, "pantone");
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to remove Pantone: " + err.message }); }
    runScan(true); return;
  }
  if (msg.type === "update-ral-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = setDescTag(v.description, "ral", msg.ralValue);
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to update RAL: " + err.message }); }
    runScan(true); return;
  }
  if (msg.type === "delete-ral-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = removeDescTag(v.description, "ral");
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to remove RAL: " + err.message }); }
    runScan(true); return;
  }
  if (msg.type === "update-vinyl-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = setDescTag(v.description, "vinyl", msg.vinylValue);
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to update Vinyl: " + err.message }); }
    runScan(true); return;
  }
  if (msg.type === "delete-vinyl-variable") {
    try {
      const v = await figma.variables.getVariableByIdAsync(msg.colorVarId);
      if (v) v.description = removeDescTag(v.description, "vinyl");
    } catch (err) { figma.ui.postMessage({ type: "error", message: "Failed to remove Vinyl: " + err.message }); }
    runScan(true); return;
  }

  if (msg.type === "request-scan") { runScan(); return; }
  if (msg.type === "close") { figma.closePlugin(); return; }

  if (msg.type === "open-external-url") {
    try { figma.openExternal(msg.url); } catch (_) {}
    return;
  }

  if (msg.type === "focus-node") {
    try {
      const node = await figma.getNodeByIdAsync(msg.nodeId);
      if (node) {
        const page = getPageForNode(node);
        if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: "Focus error: " + err.message });
    }
    return;
  }

  if (msg.type === "focus-nodes") {
    try {
      const nodes = (await Promise.all(
        (msg.nodeIds || []).map(id => figma.getNodeByIdAsync(id).catch(() => null))
      )).filter(Boolean);
      if (nodes.length > 0) {
        const page = getPageForNode(nodes[0]);
        if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
        figma.currentPage.selection = nodes;
        figma.viewport.scrollAndZoomIntoView(nodes);
      }
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: "Focus error: " + err.message });
    }
    return;
  }
};
