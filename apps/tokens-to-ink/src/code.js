// Tokens to Ink
// Scans on launch, then only when asked. With nothing selected it lists every
// colour variable the file can use. Exports as vector PDF or 300 DPI CMYK TIFF.
// Output values (CMYK, Pantone, RAL, Vinyl) are stored as tags in the origin
// color variable's description field, e.g.: [cmyk:0,100,100,0] [pantone:485 C]

import {
  rgbToHex, rgbToCmyk, parseCmykString,
  parseDescTag, setDescTag, removeDescTag,
  collectNodeColors, collectVarIds, collectImageFills,
  attachWindowResize, focusNode, getPageForNode,
  effectiveImageDpi,
} from '@rms/core';

figma.showUI(__html__, { width: 600, height: 600 });

const handleResizeMsg = attachWindowResize(figma, { defaultW: 600, defaultH: 600, minW: 320, minH: 200 });

let _exportCancelled = false;
let _exportState = null; // { selection, format, colorLookup, tiffDpi } — persists across ack messages
// imageHash → { width, height } | null. A bitmap's source size is fixed for its hash, so we
// resolve each hash's getSizeAsync ONCE and reuse it across preflight scans (dpi changes then
// re-filter with no round-trips). Replacing an image changes its hash, so this never goes stale.
const _preflightSizeCache = new Map();
// imageHash → a short reason string if the image will NOT convert to CMYK on PDF export (it
// stays RGB), or null if it converts fine. Sniffed once per hash from the stored bytes.
const _preflightFormatCache = new Map();
// The image-fill tree walk (collectImageFills over the whole selection) does NO bitmap loads, but
// on a large image frame it still costs real time — and it re-ran on every preflight-request, i.e.
// on every Colors<->Export switch. Cache the walked+scaled fills keyed by the scanned-selection
// signature; a fresh scan (selection change or edit) clears it, so it only dedupes repeat
// preflights on an unchanged selection (the tab-switch case). { sig, fills } | null.
let _preflightFillsCache = null;
let _scanCancelled = false;

// Sniff an image's stored bytes to predict whether the CMYK PDF converter will leave it as RGB.
// This is a BEST-EFFORT hint, not the truth: Figma re-encodes images when it writes the PDF, and
// the source bytes can't reveal that re-encoding (predictors, colour-space changes). The one case
// that reliably survives un-convertible is a CMYK (4-channel) JPEG, which Figma passes through as
// DCTDecode — so that's all we flag here. Everything else (PNG/GIF/WebP…) is re-encoded to RGB by
// Figma and converts fine, so flagging it would be a false alarm. The export-time check on the
// actual PDF (convertRgbImagesToCmyk) remains the ground truth. Returns a reason or null.
function classifyImageBytes(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {   // JPEG — walk markers to the SOF component count
    let i = 2;
    while (i + 1 < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xFF) { i++; continue; }                       // fill byte
      if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      if (i + 3 >= bytes.length) break;
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) break;
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (i + 9 >= bytes.length) break;
        return bytes[i + 9] === 4 ? "CMYK JPEG" : null;             // 4 components = CMYK/YCCK
      }
      i += 2 + len;
    }
  }
  return null;   // not a CMYK JPEG → assume Figma re-encodes it to convertible RGB
}
// Bumped on every preflight request; an in-flight scan bails the moment a newer one starts,
// so the debounced dpi re-scans never overlap and decode images twice at once.
let _preflightSeq = 0;
// Peak-memory guard for the low-res image scan. getImageByHash(h).getSizeAsync() forces Figma
// to load the bitmap; firing it for every unique hash at once (Promise.all over hundreds of
// large images) spikes the file's memory hard enough to crash Figma. A small pool keeps peak
// memory flat while staying concurrent. Bails between items when `shouldStop` turns true.
const PREFLIGHT_DECODE_POOL = 4;
async function mapPool(items, limit, fn, shouldStop) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      if (shouldStop && shouldStop()) return;
      await fn(items[i++]);
    }
  });
  await Promise.all(runners);
}

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
  // Resolve every colour in parallel — each resolveColorValue is an async alias walk,
  // so a file with many tokens paid one round-trip after another before this.
  const resolved = await Promise.all(
    colorVariables.map((cv) => resolveColorValue(cv, allVariablesById))
  );
  // Write in the original order. When two variables resolve to the same hex, a
  // manually-tagged [cmyk:...] value is authoritative and must not be overwritten by
  // a later variable that lands on the same colour but only has a computed value.
  // Between two manual tags for one hex, the later one still wins.
  const hasManual = new Set();
  for (let i = 0; i < colorVariables.length; i++) {
    const colorValue = resolved[i];
    if (!colorValue) continue;
    const cv = colorVariables[i];
    const hex = rgbToHex(colorValue.r, colorValue.g, colorValue.b);
    const cmykStr = parseDescTag(cv.description, "cmyk");
    const manual = cmykStr ? parseCmykString(cmykStr) : null;
    const pantone = parseDescTag(cv.description, "pantone") || null;
    if (manual) {
      lookup[hex] = { ...manual, pantone };
      hasManual.add(hex);
    } else if (!hasManual.has(hex)) {
      lookup[hex] = { ...rgbToCmyk(colorValue.r, colorValue.g, colorValue.b), pantone };
    } else if (pantone && lookup[hex] && !lookup[hex].pantone) {
      lookup[hex].pantone = pantone;   // keep the manual CMYK, but pick up a Pantone if it had none
    }
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
  _preflightFillsCache = null;   // the selection (or its contents) may have changed — re-walk next preflight
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

// collectionId → libraryName, resolved once per session. A collection's owning
// library is stable while the file is open, so repeat scans reuse it instead of
// paying a getVariableCollectionByIdAsync round-trip per unique collection every
// time. Only successful resolutions are cached, so a library linked mid-session
// still resolves on the next scan.
const _collLibNameCache = new Map();

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
          if (_collLibNameCache.has(collId)) { collectionToLib.set(collId, _collLibNameCache.get(collId)); continue; }
          const coll = await figma.variables.getVariableCollectionByIdAsync(collId).catch(() => null);
          const match = coll ? libCollections.find(lc => lc.key === coll.key) : null;
          const libName = match ? match.libraryName : null;
          collectionToLib.set(collId, libName);
          if (libName) _collLibNameCache.set(collId, libName); // cache positive hits for the session
        }
        for (const r of externalResults) {
          const libName = collectionToLib.get(r.collectionId);
          if (libName) libraries[r.colorVarId] = libName;
        }

        figma.ui.postMessage({ type: 'external-vars-resolved', libraries });
      } catch (_) {
        // Library-name resolution failed (no teamLibrary access, network hiccup).
        // Still answer, so the UI stops waiting and settles on the generic external
        // tooltip instead of a permanently-pending one.
        figma.ui.postMessage({ type: 'external-vars-resolved', libraries: {} });
      }
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

// The exported PDF's page box (MediaBox) is the frame's RENDER bounds — it grows to
// include anything spilling outside the frame. Crop marks must sit at the frame's own
// box (the trim/cut line), so return that rect in PDF coordinates (origin bottom-left,
// y-up). Returns null when bounds aren't available (caller falls back to the page box).
function frameTrimBox(node) {
  const abb = node.absoluteBoundingBox, arb = node.absoluteRenderBounds;
  if (!abb || !arb) return null;
  const x0 = abb.x - arb.x;                 // offset from the content's left edge
  const y1 = arb.height - (abb.y - arb.y);  // frame top, flipped into PDF y-up
  return { x0, y0: y1 - abb.height, x1: x0 + abb.width, y1 };
}

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
        // Uint8Array travels over postMessage as-is; Array.from would 8x the memory
        // and serialisation for a multi-MB export. The UI already wraps it in new
        // Uint8Array(...) on receipt.
        type: "export-data", format: "pdf",
        pdfBytes: pdfBytes,
        trimBox: frameTrimBox(node),
        colorLookup, frameName: node.name, fileName: figma.root.name, index: i, total: selection.length,
      });
    } else {
      const dpi = _exportState.tiffDpi || 300;
      const dpiScale = dpi / 72;
      const pngBytes = await node.exportAsync({
        format: "PNG", constraint: { type: "SCALE", value: dpiScale },
      });
      if (_exportCancelled) return;
      figma.ui.postMessage({
        type: "export-data", format: "tiff",
        pngBytes: pngBytes, dpi,
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

  if (msg.type === "get-settings") {
    const s = await figma.clientStorage.getAsync('exportSettings');
    if (s) {
      figma.ui.postMessage({
        type: 'settings',
        cropMarks: !!s.cropMarks,
        regMarks: !!s.regMarks,
        colorBars: !!s.colorBars,
        pageInfo: !!s.pageInfo,
        bleedOn: !!s.bleedOn,
        bleedMm: typeof s.bleedMm === 'number' ? s.bleedMm : 3,
        downsample: !!s.downsample,
        downsampleDpi: typeof s.downsampleDpi === 'number' ? s.downsampleDpi : 300,
        tiffDpi: typeof s.tiffDpi === 'number' ? s.tiffDpi : 300,
        tiffZip: s.tiffZip !== false,
        preserveSpot: s.preserveSpot !== false,
        pdfx: s.pdfx !== false,
        imagesCmyk: !!s.imagesCmyk,
      });
    }
    return;
  }

  if (msg.type === "save-settings") {
    await figma.clientStorage.setAsync('exportSettings', {
      cropMarks: !!msg.cropMarks,
      regMarks: !!msg.regMarks,
      colorBars: !!msg.colorBars,
      pageInfo: !!msg.pageInfo,
      bleedOn: !!msg.bleedOn,
      bleedMm: typeof msg.bleedMm === 'number' ? msg.bleedMm : 3,
      downsample: !!msg.downsample,
      downsampleDpi: typeof msg.downsampleDpi === 'number' ? msg.downsampleDpi : 300,
      tiffDpi: typeof msg.tiffDpi === 'number' ? msg.tiffDpi : 300,
      tiffZip: msg.tiffZip !== false,
      preserveSpot: msg.preserveSpot !== false,
      pdfx: msg.pdfx !== false,
      imagesCmyk: !!msg.imagesCmyk,
    });
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

    const tiffDpi = typeof msg.tiffDpi === "number" && msg.tiffDpi > 0 ? msg.tiffDpi : 300;
    _exportState = { selection, format, colorLookup, tiffDpi };
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

  // Pre-flight for the export modal: report any raster image below the target DPI (which
  // downsampling can't fix — it only shrinks). Each row carries the node id so the UI can
  // focus the item on canvas. Read-only; no export.
  if (msg.type === "preflight-request") {
    const seq = ++_preflightSeq;            // a newer request supersedes this in-flight one
    const superseded = () => _preflightSeq !== seq;
    const target = typeof msg.dpi === "number" && msg.dpi > 0 ? msg.dpi : 300;
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

    // The export renders each selected node in its OWN coordinate space, so an image's placed
    // size is its local box scaled by ancestors DOWN FROM that root — its absolute scale ÷ the
    // root's. Fold that into boxW/boxH before measuring DPI. This walk is property-only (no
    // bitmap loads), so it also cheaply answers "does the selection contain any image?" —
    // which the modal uses to decide whether to offer the Image-quality tab at all.
    const scaleOf = (n) => {
      const at = n && n.absoluteTransform;
      return at && at[0] && at[1]
        ? { x: Math.hypot(at[0][0], at[1][0]) || 1, y: Math.hypot(at[0][1], at[1][1]) || 1 }
        : { x: 1, y: 1 };
    };
    // The walk is deterministic for a given selection tree, so reuse it across repeat preflights
    // on the same scanned selection (every Colors<->Export switch) — only a fresh scan invalidates.
    const sig = selection.map(n => n.id).join(",");
    let fills;
    if (_preflightFillsCache && _preflightFillsCache.sig === sig) {
      fills = _preflightFillsCache.fills;
    } else {
      fills = [];
      for (const n of selection) {
        if (superseded()) return;
        const rootFills = [];
        await collectImageFills(n, rootFills, superseded);
        const rs = scaleOf(n);
        for (const f of rootFills) {
          f.boxW = f.boxW * ((f.absScaleX || 1) / rs.x);
          f.boxH = f.boxH * ((f.absScaleY || 1) / rs.y);
          fills.push(f);
        }
      }
      _preflightFillsCache = { sig, fills };   // only reached if the walk finished (not superseded)
    }
    const hasImages = fills.length > 0;
    // Answer "does the selection have images?" IMMEDIATELY (this walk was property-only, no bitmap
    // loads) so the modal can reveal the tabs and open without waiting on the slow byte/size scans
    // below. The lists that follow populate the (background) Image-quality tab a moment later.
    figma.ui.postMessage({ type: "preflight-selection", hasImages });
    if (superseded()) return;

    // Images that won't convert to CMYK (stay RGB). Only relevant when the user opted into CMYK
    // conversion (msg.scanCmyk) — reading every image's bytes (getBytesAsync) is the heavy part, so
    // it must not run when the "stays RGB" list isn't even shown. Sniff each UNIQUE hash once,
    // through the same small pool that caps peak memory, and keep one row per node.
    let unconvertible = [];
    if (hasImages && msg.scanCmyk) {
      const needFmt = [...new Set(fills.map(f => f.imageHash))].filter(h => !_preflightFormatCache.has(h));
      await mapPool(needFmt, PREFLIGHT_DECODE_POOL, async (h) => {
        try {
          const img = figma.getImageByHash(h);
          if (!img) { _preflightFormatCache.set(h, "missing image"); return; }
          _preflightFormatCache.set(h, classifyImageBytes(await img.getBytesAsync()));
        } catch (_) { /* leave uncached — retried next scan */ }
      }, superseded);
      if (superseded()) return;

      const badByNode = new Map();   // one row per node — the first un-convertible image on it
      for (const f of fills) {
        const reason = _preflightFormatCache.get(f.imageHash);
        if (!reason) continue;                                  // convertible (or not yet sniffed)
        if (!badByNode.has(f.nodeId)) badByNode.set(f.nodeId, { id: f.nodeId, name: f.name, meta: reason });
      }
      unconvertible = [...badByNode.values()];
    }

    // The low-res list is only computed when asked (PDF + downsample on) AND there are images.
    // getSizeAsync is the slow, memory-heavy part — each call makes Figma load the bitmap — so
    // resolve every UNIQUE, uncached hash through a small pool (not one Promise.all over all of
    // them), decoding a few at a time instead of all at once (which spiked memory and crashed
    // Figma). Cache ONLY successful sizes so a failed fetch retries next scan.
    let images = [];
    if (msg.scanImages !== false && hasImages) {
      const needed = [...new Set(fills.map(f => f.imageHash))].filter(h => !_preflightSizeCache.has(h));
      await mapPool(needed, PREFLIGHT_DECODE_POOL, async (h) => {
        try {
          const img = figma.getImageByHash(h);
          if (!img) return;
          const src = await img.getSizeAsync();
          if (src && src.width && src.height) _preflightSizeCache.set(h, src);
        } catch (_) { /* leave uncached — retried next scan */ }
      }, superseded);
      if (superseded()) return;   // a newer scan started — drop this one's stale results

      const worstByNode = new Map();   // one row per node — its lowest-DPI image
      for (const f of fills) {
        const src = _preflightSizeCache.get(f.imageHash);
        if (!src || !src.width || !src.height) continue;
        const dpi = effectiveImageDpi(f, src.width, src.height, f.boxW, f.boxH);
        if (!dpi) continue;                                   // undeterminable (e.g. TILE, no factor)
        const lowest = Math.min(dpi.dpiX, dpi.dpiY);
        if (lowest >= target) continue;                       // meets target → not flagged
        const dpiX = Math.round(dpi.dpiX), dpiY = Math.round(dpi.dpiY);
        const dpiLabel = dpiX === dpiY ? `${dpiX} dpi` : `${dpiX}×${dpiY} dpi`;
        const entry = { id: f.nodeId, name: f.name, lowest, meta: `${src.width}×${src.height} px · ${dpiLabel}` };
        const prev = worstByNode.get(f.nodeId);
        if (!prev || entry.lowest < prev.lowest) worstByNode.set(f.nodeId, entry);
      }
      images = [...worstByNode.values()].map(e => ({ id: e.id, name: e.name, meta: e.meta }));
    }
    if (superseded()) return;
    figma.ui.postMessage({ type: "preflight-images", target, hasImages, images, unconvertible });
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
    const r = await focusNode(figma, msg.nodeId);
    if (r.error) figma.ui.postMessage({ type: "error", message: "Focus error: " + r.error.message });
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
