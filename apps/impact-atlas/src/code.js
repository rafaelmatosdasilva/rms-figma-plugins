import { rgbToHex, yieldTick, attachWindowResize } from '@rms/core';

figma.showUI(__html__, { width: 1000, height: 540, title: 'Impact Atlas' });

const handleResizeMsg = attachWindowResize(figma, { defaultW: 1000, defaultH: 540 });

// ─── Module state ─────────────────────────────────────────────────────────────

let _aliasMap            = new Map(); // varId → Set<targetId>
let _reverseAliasMap     = new Map(); // targetId → Set<aliaserId>
let _varById             = new Map(); // id → Variable
let _collById            = new Map(); // id → Collection
let _descendantCounts    = new Map(); // varId → unique descendant count
let _componentsByVarId   = new Map(); // varId → Set<componentId>
let _componentById       = new Map(); // componentId → { name, type, pageName, pageId }
let _componentIndexBuilt = false;     // true after first index build
let _componentBrowserCache = null;    // cached result for component browser (all components)
let _indexBuildPromise   = null;      // in-progress buildComponentIndex promise (deduplicates concurrent calls)
let _externalAliasMap    = new Map(); // local varId → external varId (library alias target)
let _externalVarCache    = new Map(); // external varId → info object | null
let _localVarIds         = new Set(); // IDs of variables defined in this file

// Node types that can carry variable bindings — used by findAllWithCriteria
// to skip GROUP/SECTION/SLICE/STICKY/etc. natively instead of in JS recursion.
// SLOT is included: component slots carry their own fills/strokes/radius bindings
// (e.g. segmentedControl's background lives on its Slot child), and omitting it made
// those bindings invisible — the token showed as unused though a component used it.
const BINDING_TYPES = [
  'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SLOT',
  'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE',
  'VECTOR', 'BOOLEAN_OPERATION', 'TEXT',
];

// ─── Alias map ────────────────────────────────────────────────────────────────

function buildAliasMaps(allVars) {
  _aliasMap        = new Map();
  _reverseAliasMap = new Map();
  _varById         = new Map();
  _externalAliasMap = new Map();

  for (const v of allVars) {
    _varById.set(v.id, v);
    _aliasMap.set(v.id, new Set());
  }

  for (const v of allVars) {
    const coll = _collById.get(v.variableCollectionId);
    if (!coll) continue;
    const validModeIds = new Set(coll.modes.map(m => m.modeId));

    for (const [modeId, value] of Object.entries(v.valuesByMode)) {
      if (!validModeIds.has(modeId)) continue;
      if (!value || typeof value !== 'object' || value.type !== 'VARIABLE_ALIAS' || !value.id) continue;

      if (!_varById.has(value.id)) {
        // Target is a library/external variable — record the first one found per local var
        if (!_externalAliasMap.has(v.id)) _externalAliasMap.set(v.id, value.id);
        continue;
      }

      _aliasMap.get(v.id).add(value.id);
      if (!_reverseAliasMap.has(value.id)) _reverseAliasMap.set(value.id, new Set());
      _reverseAliasMap.get(value.id).add(v.id);
    }

    // Fallback: if no alias edge was registered (e.g. alias was set under a
    // since-deleted mode whose ID no longer appears in validModeIds), scan ALL
    // valuesByMode entries — stale mode IDs included — and record the first
    // VARIABLE_ALIAS found so getAncestors() can still walk the chain.
    if (_aliasMap.get(v.id).size === 0 && !_externalAliasMap.has(v.id)) {
      for (const value of Object.values(v.valuesByMode)) {
        if (!value || typeof value !== 'object' || value.type !== 'VARIABLE_ALIAS' || !value.id) continue;
        if (!_varById.has(value.id)) {
          _externalAliasMap.set(v.id, value.id);
        } else {
          _aliasMap.get(v.id).add(value.id);
          if (!_reverseAliasMap.has(value.id)) _reverseAliasMap.set(value.id, new Set());
          _reverseAliasMap.get(value.id).add(v.id);
        }
        break; // first alias found is enough
      }
    }
  }
}

// ─── Descendant counts ────────────────────────────────────────────────────────

function buildDescendantCountMap() {
  const counts = new Map();
  for (const id of _varById.keys()) {
    const visited = new Set([id]);
    const queue   = [id];
    let head = 0;
    while (head < queue.length) {
      const current  = queue[head++];
      const children = _reverseAliasMap.get(current);
      if (children) {
        for (const childId of children) {
          if (!visited.has(childId)) { visited.add(childId); queue.push(childId); }
        }
      }
    }
    counts.set(id, visited.size - 1);
  }
  return counts;
}

// ─── Value resolution ─────────────────────────────────────────────────────────

function resolveToRaw(variableId, depth) {
  if (depth > 32) return null;
  const v = _varById.get(variableId);
  if (!v) return null;
  const coll  = _collById.get(v.variableCollectionId);
  const modeId = coll && coll.modes[0] && coll.modes[0].modeId;
  if (!modeId) return null;
  const val = v.valuesByMode[modeId];
  if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') return resolveToRaw(val.id, depth + 1);
  return val != null ? val : null;
}

function resolveHex(variableId) {
  const raw = resolveToRaw(variableId, 0);
  if (raw && typeof raw === 'object' && raw.type !== 'VARIABLE_ALIAS') {
    const { r, g, b } = raw;
    if (r != null && g != null && b != null) return rgbToHex(r, g, b);
  }
  // No raw RGB (e.g. a remote var seeded from cache on reopen) — fall back to the
  // hex precomputed and cached at scan time, if the variable carries one.
  const v = _varById.get(variableId);
  return (v && typeof v.hex === 'string') ? v.hex : null;
}

// ─── Chain node ───────────────────────────────────────────────────────────────

function makeChainNode(id, depth, isCyclic, aliasTargetId) {
  const v    = _varById.get(id);
  const coll = v ? _collById.get(v.variableCollectionId) : null;
  const aliasModes = [];
  if (v && coll) {
    for (const mode of coll.modes) {
      const val = v.valuesByMode[mode.modeId];
      if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
        if (!aliasTargetId || val.id === aliasTargetId) aliasModes.push(mode.name);
      }
    }
  }
  return {
    id,
    name:           v ? v.name : id,
    resolvedType:   v ? v.resolvedType : 'UNKNOWN',
    collectionName: coll ? coll.name : '',
    depth,
    hex:            v && v.resolvedType === 'COLOR' ? resolveHex(id) : null,
    isCyclic:       !!isCyclic,
    isExternal:     false,
    aliasModes,
    totalModes:     coll ? coll.modes.length : 0,
    hasChildren:    false,
  };
}

// ─── Impact scoring ───────────────────────────────────────────────────────────

/**
 * Classifies the token's role in the alias graph:
 *   primitive  — raw value root (no ancestors)
 *   bridge     — middle layer (has ancestors AND descendants)
 *   terminal   — leaf (has ancestors but no descendants)
 *   standalone — isolated (no ancestors, no descendants)
 */
function classifyToken(chain) {
  const hasAnc  = chain.ancestors.length > 0;
  const hasDesc = chain.descendants.length > 0;
  if (!hasAnc && hasDesc)  return { type: 'primitive', multiplier: 0.5 };
  if (hasAnc  && hasDesc)  return { type: 'bridge',    multiplier: 1.5 };
  if (hasAnc  && !hasDesc) return { type: 'terminal',  multiplier: 1.0 };
  // No ancestors, no descendants — raw value not yet connected to a chain
  return                         { type: 'primitive',  multiplier: 0.5 };
}

/**
 * Computes the impact score for a variable.
 * componentCount: pass null before the index is built (estimated mode).
 */
function computeImpact(variableId, chain, componentCount) {
  const varDeps    = _descendantCounts.get(variableId) || 0;
  const depth      = chain.ancestors.length;
  const compUsage  = componentCount != null ? componentCount : 0;
  const { type: tokenType, multiplier } = classifyToken(chain);

  // Impact = what DEPENDS ON this token (alias tokens that reference it + components
  // that use it). The token's own upward alias chain (depth = ancestors) is NOT impact:
  // a token that references a primitive but is referenced by nothing breaks nothing when
  // changed. Including depth here gave those zero-reference tokens a non-zero score, so
  // they landed in "Low" instead of "Unused". (The UI's local-mode score already omits
  // depth — this makes Full-scan agree.)
  const base  = (varDeps * 6) + (compUsage * 4);
  const score = Math.round(base * multiplier);

  return { score, tokenType, multiplier, varDeps, depth, compUsage };
}

// ─── External variable fetching ───────────────────────────────────────────────

async function fetchExternalVarInfo(externalId) {
  if (_externalVarCache.has(externalId)) return _externalVarCache.get(externalId);
  try {
    const v = await figma.variables.getVariableByIdAsync(externalId);
    if (!v) { _externalVarCache.set(externalId, null); return null; }

    let collectionName = '';
    try {
      const coll = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
      if (coll) collectionName = coll.name;
    } catch (_) {}

    // Attempt one-level hex resolution for COLOR vars
    let hex = null;
    if (v.resolvedType === 'COLOR') {
      try {
        const firstModeId = Object.keys(v.valuesByMode)[0];
        if (firstModeId) {
          const val = v.valuesByMode[firstModeId];
          if (val && typeof val === 'object' && val.r != null && val.g != null && val.b != null) {
            hex = rgbToHex(val.r, val.g, val.b);
          }
        }
      } catch (_) {}
    }

    const info = { name: v.name, resolvedType: v.resolvedType, collectionName, hex, isExternal: true };
    _externalVarCache.set(externalId, info);
    return info;
  } catch (_) {
    _externalVarCache.set(externalId, null);
    return null;
  }
}

// ─── Chain traversal ──────────────────────────────────────────────────────────

// Synchronously predict the next ancestor ID from the current node using all
// available in-memory data. Returns null if the ID is unknown or chain ends.
function _nextAncestorId(current, visited) {
  const targets = _aliasMap.get(current);
  if (targets && targets.size > 0) {
    const t = targets.values().next().value;
    return visited.has(t) ? null : t;
  }
  const extId = _externalAliasMap.get(current);
  if (extId && !visited.has(extId)) return extId;
  const v = _varById.get(current);
  if (v && v.valuesByMode) {
    for (const val of Object.values(v.valuesByMode)) {
      if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && val.id && !visited.has(val.id)) return val.id;
    }
  }
  return null;
}

async function getAncestors(variableId) {
  // ── Pass 1: walk the chain synchronously to collect IDs that need fetching ──
  const toFetch  = [];
  const visited1 = new Set([variableId]);
  let cur1 = variableId;
  for (let guard = 0; guard < 30; guard++) {
    const nextId = _nextAncestorId(cur1, visited1);
    if (!nextId) break;
    visited1.add(nextId);
    if (!_varById.has(nextId) && !_externalVarCache.has(nextId)) toFetch.push(nextId);
    cur1 = nextId;
  }

  // ── Pass 2: batch-fetch all unknown IDs in parallel ──
  if (toFetch.length > 0) {
    await Promise.all(toFetch.map(id => fetchExternalVarInfo(id)));
    // fetchExternalVarInfo populates _externalVarCache; also add fetched vars to _varById
    for (const id of toFetch) {
      if (!_varById.has(id)) {
        try {
          const v = await figma.variables.getVariableByIdAsync(id).catch(() => null);
          if (v) _varById.set(v.id, v);
        } catch (_) {}
      }
    }
  }

  // ── Pass 3: walk again and build ancestor nodes (all data now in cache) ──
  const ancestors = [];
  const visited   = new Set([variableId]);
  let current     = variableId;
  while (true) {
    const targets = _aliasMap.get(current);
    if (!targets || targets.size === 0) {
      const extId = _externalAliasMap.get(current);
      if (extId) {
        if (_varById.has(extId)) {
          const node = makeChainNode(extId, 0, false, null);
          node.isExternal = true;
          ancestors.push(node);
        } else {
          const info = _externalVarCache.get(extId);
          if (info) {
            ancestors.push({
              id: extId, name: info.name, resolvedType: info.resolvedType,
              collectionName: info.collectionName, depth: 0, hex: info.hex,
              isCyclic: false, isExternal: true, aliasModes: [], totalModes: 0, hasChildren: false,
            });
          }
        }
        break;
      }
      // Fallback: scan valuesByMode for remote variables
      const curVar = _varById.get(current);
      if (curVar && curVar.valuesByMode) {
        let foundId = null;
        for (const val of Object.values(curVar.valuesByMode)) {
          if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && val.id && !visited.has(val.id)) {
            foundId = val.id; break;
          }
        }
        if (foundId) {
          visited.add(foundId);
          if (_varById.has(foundId)) {
            const node = makeChainNode(foundId, 0, false, null);
            node.isExternal = !_localVarIds.has(foundId);
            ancestors.push(node);
            current = foundId;
            continue;
          } else {
            const info = _externalVarCache.get(foundId);
            if (info) {
              ancestors.push({
                id: foundId, name: info.name, resolvedType: info.resolvedType,
                collectionName: info.collectionName, depth: 0, hex: info.hex,
                isCyclic: false, isExternal: true, aliasModes: [], totalModes: 0, hasChildren: false,
              });
            }
          }
        }
      }
      break;
    }
    const targetId = targets.values().next().value;
    if (visited.has(targetId)) { ancestors.push(makeChainNode(targetId, 0, true, null)); break; }
    visited.add(targetId);
    ancestors.push(makeChainNode(targetId, 0, false, null));
    current = targetId;
  }
  ancestors.reverse();
  ancestors.forEach((n, i) => { n.depth = i; });
  return ancestors;
}

function getDescendants(variableId, selfDepth) {
  const descendants    = [];
  const visited        = new Set([variableId]);
  const queue          = [{ id: variableId, depth: selfDepth }];
  const hasChildrenSet = new Set();

  let head = 0;
  while (head < queue.length) {
    const { id: currentId, depth } = queue[head++];
    const aliasers = _reverseAliasMap.get(currentId);
    if (!aliasers) continue;
    for (const aliserId of aliasers) {
      hasChildrenSet.add(currentId);
      if (visited.has(aliserId)) {
        descendants.push(makeChainNode(aliserId, depth + 1, true, currentId));
        continue;
      }
      visited.add(aliserId);
      descendants.push(makeChainNode(aliserId, depth + 1, false, currentId));
      queue.push({ id: aliserId, depth: depth + 1 });
    }
  }
  for (const node of descendants) node.hasChildren = hasChildrenSet.has(node.id);
  return descendants;
}

async function buildChain(variableId) {
  const ancestors   = await getAncestors(variableId);
  const selfDepth   = ancestors.length;
  const self        = makeChainNode(variableId, selfDepth, false, null);
  const descendants = getDescendants(variableId, selfDepth);
  return {
    selectedId: variableId,
    ancestors,
    self,
    descendants,
    blastRadius: { totalDescendants: _descendantCounts.get(variableId) || 0 },
  };
}

// ─── Component index ──────────────────────────────────────────────────────────

// Flat (no recursion) and type-aware. Called once per node after
// findAllWithCriteria has already filtered to binding-capable types.
// Note: intentionally NOT skipping invisible nodes — a layer hidden in one
// variant may carry a variable that's visible in another variant state.
function collectNodeVarIds(node, varIds) {
  const type = node.type;

  // 1. Direct boundVariables (spacing, opacity, radius, etc.)
  try {
    const bv = node.boundVariables;
    if (bv) {
      for (const key in bv) {
        if (key === 'fills' || key === 'strokes' || key === 'effects') continue;
        const binding = bv[key];
        if (Array.isArray(binding)) { for (let i = 0; i < binding.length; i++) { const b = binding[i]; if (b && b.id) varIds.add(b.id); } }
        else if (binding && binding.id) varIds.add(binding.id);
      }
    }
  } catch (_) {}

  // 2. Paint bindings (fills / strokes) — most node types support these
  try {
    const paints = node.fills;
    if (Array.isArray(paints) && paints.length > 0) {
      const nbFills = node.boundVariables && node.boundVariables.fills;
      for (let i = 0; i < paints.length; i++) {
        const paint = paints[i];
        if (paint && paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id) varIds.add(paint.boundVariables.color.id);
        if (nbFills && nbFills[i] && nbFills[i].id) varIds.add(nbFills[i].id);
      }
    }
  } catch (_) {}
  try {
    const strokes = node.strokes;
    if (Array.isArray(strokes) && strokes.length > 0) {
      const nbStrokes = node.boundVariables && node.boundVariables.strokes;
      for (let i = 0; i < strokes.length; i++) {
        const paint = strokes[i];
        if (paint && paint.boundVariables && paint.boundVariables.color && paint.boundVariables.color.id) varIds.add(paint.boundVariables.color.id);
        if (nbStrokes && nbStrokes[i] && nbStrokes[i].id) varIds.add(nbStrokes[i].id);
      }
    }
  } catch (_) {}

  // 3. Effect bindings
  try {
    const effects = node.effects;
    if (Array.isArray(effects) && effects.length > 0) {
      for (let i = 0; i < effects.length; i++) {
        const effect = effects[i];
        if (!effect || !effect.boundVariables) continue;
        for (const k in effect.boundVariables) {
          const b = effect.boundVariables[k];
          if (b && b.id) varIds.add(b.id);
        }
      }
    }
  } catch (_) {}

  // 4. TEXT-only: textRangeBoundVariables on per-character ranges
  if (type === 'TEXT') {
    try {
      const trbv = node.textRangeBoundVariables;
      if (trbv) {
        for (const k in trbv) {
          const rangeList = trbv[k];
          if (Array.isArray(rangeList)) {
            for (let i = 0; i < rangeList.length; i++) { const rb = rangeList[i]; if (rb && rb.id) varIds.add(rb.id); }
          } else if (rangeList && rangeList.id) {
            varIds.add(rangeList.id);
          }
        }
      }
    } catch (_) {}
  }

  // 5. COMPONENT / COMPONENT_SET-only: componentPropertyDefinitions
  if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
    try {
      const cpd = node.componentPropertyDefinitions;
      if (cpd) {
        for (const k in cpd) {
          const propDef = cpd[k];
          if (propDef && propDef.boundVariables) {
            for (const k2 in propDef.boundVariables) {
              const b = propDef.boundVariables[k2];
              if (b && b.id) varIds.add(b.id);
            }
          }
        }
      }
    } catch (_) {}
  }

  // 6. INSTANCE-only: componentProperties (overrides on nested instances)
  if (type === 'INSTANCE') {
    try {
      const cp = node.componentProperties;
      if (cp) {
        for (const k in cp) {
          const propDef = cp[k];
          if (propDef && propDef.boundVariables) {
            for (const k2 in propDef.boundVariables) {
              const b = propDef.boundVariables[k2];
              if (b && b.id) varIds.add(b.id);
            }
          }
        }
      }
    } catch (_) {}
  }
}

function _populateIndexFromCache(browserComponents) {
  _componentsByVarId = new Map();
  _componentById     = new Map();
  for (const comp of browserComponents) {
    _componentById.set(comp.nodeId, { name: comp.nodeName, type: comp.nodeType, pageName: comp.pageName, pageId: comp.pageId, isRemote: !!comp.isRemote });
    for (const bv of (comp.boundVars || [])) {
      if (!_componentsByVarId.has(bv.id)) _componentsByVarId.set(bv.id, new Set());
      _componentsByVarId.get(bv.id).add(comp.nodeId);
    }
  }
}

// On a cache hit we rebuild _varById from local variables only. The cached scan
// also references REMOTE variables (bound to library components); without seeding
// them here, lookupComponents' `_varById.has(vid)` filter would silently drop
// every remote bound token, so external components would show with no tokens.
// valuesByMode is left empty so resolveToRaw/resolveHex bail out safely (no colour
// swatch on reopen, but names and types resolve — which is what matters).
function _seedRemoteVarsFromCache(remoteVars, remoteColls) {
  for (const rc of (remoteColls || [])) {
    if (rc && rc.id && !_collById.has(rc.id)) {
      _collById.set(rc.id, { id: rc.id, name: rc.name, key: rc.key || null, modes: rc.modes || [] });
    }
  }
  for (const rv of (remoteVars || [])) {
    if (rv && rv.id && !_varById.has(rv.id)) {
      _varById.set(rv.id, {
        id: rv.id, name: rv.name, key: rv.libraryKey || rv.key || null,
        resolvedType: rv.resolvedType, variableCollectionId: rv.variableCollectionId,
        // No raw RGB is cached, but the hex computed at scan time is — keep it so
        // resolveHex can still produce the colour swatch on reopen.
        hex: (typeof rv.hex === 'string') ? rv.hex : null,
        valuesByMode: {}, remote: true,
      });
    }
  }
}

async function buildComponentIndex() {
  _componentsByVarId    = new Map();
  _componentById        = new Map();
  _componentBrowserCache = null; // invalidate browser cache whenever index is rebuilt

  // Load + scan pages one at a time to keep progress responsive and allow cancellation
  const pages = figma.root.children;
  const pageCount = pages.length;

  for (let pi = 0; pi < pageCount; pi++) {
    await pages[pi].loadAsync();
    if (_initCancelled) return;
    figma.ui.postMessage({ type: 'init-progress', pct: 42 + Math.round((pi / pageCount) * 38) });

    const page = pages[pi];
    const comps = page.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    for (const c of comps) {
      // Skip variant children of a COMPONENT_SET — they're scanned as part of the set
      if (c.type === 'COMPONENT' && c.parent && c.parent.type === 'COMPONENT_SET') continue;
      const node   = c;
      const varIds = new Set();

      // The component itself (componentPropertyDefinitions live here)
      collectNodeVarIds(node, varIds);

      // All binding-capable descendants in one native call
      const descendants = node.findAllWithCriteria({ types: BINDING_TYPES });
      for (let i = 0; i < descendants.length; i++) collectNodeVarIds(descendants[i], varIds);

      if (varIds.size === 0) continue;

      // Only track bindings to local variables — external bindings are resolved at Level 2
      const localVarIds = [...varIds].filter(id => _localVarIds.has(id));
      if (localVarIds.length === 0) continue;

      _componentById.set(node.id, { name: node.name, type: node.type, pageName: page.name, pageId: page.id });
      for (const varId of localVarIds) {
        if (!_componentsByVarId.has(varId)) _componentsByVarId.set(varId, new Set());
        _componentsByVarId.get(varId).add(node.id);
      }
    }

    await yieldTick();
  }

  // Phase 3: discover library components from canvas instances —
  // but ONLY if the file has linked external libraries. Files with no
  // external libraries skip this entirely and finish init at 80%.
  let hasLinkedLibs = false;
  try {
    if (figma.teamLibrary && figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync) {
      const libColls = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      hasLinkedLibs = !!(libColls && libColls.length > 0);
    }
  } catch (_) {}

  if (hasLinkedLibs) {
    figma.ui.postMessage({ type: 'init-progress', pct: 82 });
    const libCompCache = new Map();
    const MC_BATCH = 50;
    let instScanned = 0;
    let instTotal = 0;
    for (const page of pages) instTotal += page.findAllWithCriteria({ types: ['INSTANCE'] }).length;

    for (const page of pages) {
      if (_initCancelled) return;
      const instances = page.findAllWithCriteria({ types: ['INSTANCE'] });
      for (let bi = 0; bi < instances.length; bi += MC_BATCH) {
        if (_initCancelled) return;
        const slice = instances.slice(bi, bi + MC_BATCH);
        const mcs   = await Promise.all(slice.map(i => i.getMainComponentAsync().catch(() => null)));
        instScanned += slice.length;
        figma.ui.postMessage({ type: 'init-progress', pct: 82 + Math.round((instScanned / instTotal) * 16) });

        for (let j = 0; j < slice.length; j++) {
          const mc = mcs[j];
          if (!mc) continue;
          let cacheNode = mc;
          if (mc.type === 'COMPONENT' && mc.parent && mc.parent.type === 'COMPONENT_SET') cacheNode = mc.parent;
          const cacheKey = cacheNode.id;

          if (_componentById.has(cacheKey) || libCompCache.has(cacheKey)) continue;

          const varIds = new Set();
          try {
            collectNodeVarIds(cacheNode, varIds);
            const desc = cacheNode.findAllWithCriteria({ types: BINDING_TYPES });
            for (let d = 0; d < desc.length; d++) collectNodeVarIds(desc[d], varIds);
          } catch (_) {}

          libCompCache.set(cacheKey, varIds);
          if (varIds.size > 0) {
            _componentById.set(cacheKey, { name: cacheNode.name, type: cacheNode.type, pageName: 'Library', pageId: null, isRemote: true });
            for (const varId of varIds) {
              if (!_componentsByVarId.has(varId)) _componentsByVarId.set(varId, new Set());
              _componentsByVarId.get(varId).add(cacheKey);
            }
          }
        }
        await yieldTick();
      }
    }
  }

  figma.ui.postMessage({ type: 'init-progress', pct: 100 });

  // Remote variables are already fetched at init via discoverRemoteVars().
  // Defensively fetch any IDs that somehow slipped through (e.g. library updated mid-session).
  const unknownIds = [];
  for (const varId of _componentsByVarId.keys()) {
    if (!_varById.has(varId)) unknownIds.push(varId);
  }
  if (unknownIds.length > 0) {
    const fetched = await Promise.all(
      unknownIds.map(id => figma.variables.getVariableByIdAsync(id).catch(() => null))
    );
    const collIds = new Set();
    for (const v of fetched) {
      if (v) {
        _varById.set(v.id, v);
        if (!v.remote) _localVarIds.add(v.id); // local var that getLocalVariablesAsync missed
        collIds.add(v.variableCollectionId);
      }
    }
    const colls = await Promise.all(
      [...collIds].map(id => figma.variables.getVariableCollectionByIdAsync(id).catch(() => null))
    );
    for (const c of colls) { if (c) _collById.set(c.id, c); }
  }
}

// ─── Phase 1: local-only component index ──────────────────────────────────────
// Scans only local COMPONENT/COMPONENT_SET definitions — no instance traversal,
// no library API calls. Fast enough to complete during the initial plugin load.
async function buildLocalComponentIndex() {
  _componentsByVarId    = new Map();
  _componentById        = new Map();
  _componentBrowserCache = null;

  // Load + scan pages one at a time to keep progress responsive and allow cancellation
  const pages = figma.root.children;
  const pageCount = pages.length;

  for (let pi = 0; pi < pageCount; pi++) {
    await pages[pi].loadAsync();
    if (_initCancelled) return;
    figma.ui.postMessage({ type: 'init-progress', pct: 20 + Math.round((pi / pageCount) * 70) });

    const page = pages[pi];
    const comps = page.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    for (const c of comps) {
      if (c.type === 'COMPONENT' && c.parent && c.parent.type === 'COMPONENT_SET') continue;

      const node   = c;
      const varIds = new Set();
      collectNodeVarIds(node, varIds);
      const descendants = node.findAllWithCriteria({ types: BINDING_TYPES });
      for (let i = 0; i < descendants.length; i++) collectNodeVarIds(descendants[i], varIds);

      if (varIds.size === 0) continue;
      // Only register bindings to local variables — external bindings require Full scan
      const localVarIds = [...varIds].filter(id => _localVarIds.has(id));
      if (localVarIds.length === 0) continue;
      _componentById.set(node.id, { name: node.name, type: node.type, pageName: page.name, pageId: page.id });
      for (const varId of localVarIds) {
        if (!_componentsByVarId.has(varId)) _componentsByVarId.set(varId, new Set());
        _componentsByVarId.get(varId).add(node.id);
      }
    }

    await yieldTick();
  }
}

// Ensures the component index is built exactly once, even if called concurrently.
// Returns a promise that resolves when the index is ready.
function ensureComponentIndex() {
  if (_componentIndexBuilt) return Promise.resolve();
  if (_indexBuildPromise)   return _indexBuildPromise;
  _indexBuildPromise = buildComponentIndex()
    .then(() => { _componentIndexBuilt = true; })
    .finally(() => { _indexBuildPromise = null; });
  return _indexBuildPromise;
}

function lookupComponents(variableIds, selectedId) {
  // Track which chain variables each component binds
  const bindMap = new Map(); // componentId → Set<varId>
  for (const vid of variableIds) {
    const ids = _componentsByVarId.get(vid);
    if (!ids) continue;
    for (const cid of ids) {
      if (!bindMap.has(cid)) bindMap.set(cid, new Set());
      bindMap.get(cid).add(vid);
    }
  }

  const chainSet = new Set(variableIds);

  const components = [];
  for (const [cid, varSet] of bindMap) {
    // A component present in _componentsByVarId (so it counts toward the impact score)
    // must never be dropped from the detail just because its metadata wasn't indexed —
    // that produced "Low" tier with a "no components reference this variable" panel.
    // Fall back to a placeholder so the detail always reflects what the score counted.
    const meta = _componentById.get(cid)
      || { name: '(component)', type: 'COMPONENT', pageName: '', pageId: null };

    // For each bound var, walk its alias chain up to the selected variable
    // to produce a readable "aliases → ... → selected" path.
    const boundVars = [...varSet].filter(vid => _varById.has(vid)).map(vid => {
      const v = _varById.get(vid);

      // Build path: from this var upward through the alias chain until
      // we reach the selected variable (or hit a cycle / dead end).
      const path = [];
      const visited = new Set([vid]);
      let cur = vid;
      while (cur !== selectedId) {
        const targets = _aliasMap.get(cur);
        if (!targets || targets.size === 0) break;
        const next = targets.values().next().value;
        if (visited.has(next)) break;
        visited.add(next);
        if (chainSet.has(next)) {
          if (next !== selectedId) {
            const nv = _varById.get(next);
            path.push(nv ? nv.name : next);
          }
          cur = next;
        } else {
          break;
        }
      }

      return {
        id:           vid,
        name:         v ? v.name : vid,
        resolvedType: v ? v.resolvedType : 'UNKNOWN',
        hex:          v && v.resolvedType === 'COLOR' ? resolveHex(vid) : null,
        isSelected:   vid === selectedId,
        // via: intermediate names between this var and the selected var (closest first)
        via:          path,
      };
    });

    // Sort: selected var first, then by path length (direct aliases before deep ones), then name
    boundVars.sort(function (a, b) {
      if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
      if (a.via.length !== b.via.length) return a.via.length - b.via.length;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    components.push({
      nodeId: cid, nodeName: meta.name, nodeType: meta.type,
      pageName: meta.pageName, pageId: meta.pageId,
      boundCount: varSet.size, boundVars,
    });
  }

  // Most chain variables bound → least; then page; then name
  components.sort((a, b) => {
    if (b.boundCount !== a.boundCount) return b.boundCount - a.boundCount;
    const pageDiff = a.pageName.localeCompare(b.pageName);
    if (pageDiff !== 0) return pageDiff;
    return a.nodeName.localeCompare(b.nodeName);
  });
  return components;
}

// ─── Remote variable discovery ───────────────────────────────────────────────
// Scans every local variable's alias values for targets that aren't local.
// Fetches those remote variables and their collections from the Figma API.
// Returns { remoteVars, remoteColls } ready to send to the UI.

async function discoverRemoteVarsFromAliases() {
  // Map: remoteId → Set<localVarId> that aliases it
  const remoteIdToAliasers = new Map();

  for (const [localId, v] of _varById) {
    const coll = _collById.get(v.variableCollectionId);
    if (!coll) continue;
    const validModeIds = new Set(coll.modes.map(m => m.modeId));
    for (const [modeId, val] of Object.entries(v.valuesByMode)) {
      if (!validModeIds.has(modeId)) continue;
      if (!val || typeof val !== 'object' || val.type !== 'VARIABLE_ALIAS' || !val.id) continue;
      if (_varById.has(val.id)) continue; // local — skip
      if (!remoteIdToAliasers.has(val.id)) remoteIdToAliasers.set(val.id, new Set());
      remoteIdToAliasers.get(val.id).add(localId);
    }
  }

  if (remoteIdToAliasers.size === 0) return { remoteVars: [], remoteColls: [] };

  const remoteIds  = [...remoteIdToAliasers.keys()];
  const fetched    = await Promise.all(remoteIds.map(id => figma.variables.getVariableByIdAsync(id).catch(() => null)));

  const collIds    = new Set();
  const remoteVars = [];
  for (const v of fetched) {
    if (!v) continue;
    _varById.set(v.id, v);
    collIds.add(v.variableCollectionId);
    remoteVars.push({
      id:                   v.id,
      libraryKey:           v.key || null,
      name:                 v.name,
      resolvedType:         v.resolvedType,
      variableCollectionId: v.variableCollectionId,
      hex:                  v.resolvedType === 'COLOR' ? resolveHex(v.id) : null,
      aliasCount:           (remoteIdToAliasers.get(v.id) || new Set()).size,
      isRemote:             true,
    });
  }

  const colls      = await Promise.all([...collIds].map(id => figma.variables.getVariableCollectionByIdAsync(id).catch(() => null)));
  const remoteColls = [];
  for (const c of colls) {
    if (c) { _collById.set(c.id, c); remoteColls.push({ id: c.id, key: c.key || null, name: c.name, modes: c.modes, isRemote: true }); }
  }

  return { remoteVars, remoteColls };
}

// Enumerates EVERY library variable available to this file (used or not).
// Returns synthetic stubs keyed by libraryKey — these don't have real Variable IDs
// until imported via importVariableByKeyAsync().
async function enumerateAllLibraryVars() {
  try {
    if (!figma.teamLibrary || !figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync) {
      console.warn('[token-chain] figma.teamLibrary API not available');
      return { libVars: [], libColls: [] };
    }
    const libColls = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    console.log('[token-chain] enumerated library collections:', libColls ? libColls.length : 0);
    if (!libColls || libColls.length === 0) return { libVars: [], libColls: [] };

    const libVarsPerColl = await Promise.all(
      libColls.map(c => figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key).catch(() => []))
    );

    const libVars   = [];
    const collStubs = [];
    for (let i = 0; i < libColls.length; i++) {
      const c          = libColls[i];
      const varsInColl = libVarsPerColl[i] || [];
      const collId     = 'LIB_KEY:' + c.key;
      collStubs.push({
        id:          collId,
        key:         c.key,
        name:        c.name,
        libraryName: c.libraryName || '',
        modes:       [],
        isRemote:    true,
      });
      for (const lv of varsInColl) {
        libVars.push({
          id:                   'LIB_KEY:' + lv.key,
          libraryKey:           lv.key,
          name:                 lv.name,
          resolvedType:         lv.resolvedType,
          variableCollectionId: collId,
          hex:                  null,
          aliasCount:           0,
          isRemote:             true,
          libraryName:          c.libraryName || '',
        });
      }
    }
    return { libVars, libColls: collStubs };
  } catch (err) {
    console.warn('[token-chain] enumerateAllLibraryVars failed:', err && err.message);
    return { libVars: [], libColls: [] };
  }
}

// Returns all local variables that directly alias a given remote variable.
async function handleGetReferencedBy(remoteVarId) {
  const referencedBy = [];
  for (const [localId, v] of _varById) {
    if (!_localVarIds.has(localId)) continue;
    const coll = _collById.get(v.variableCollectionId);
    if (!coll) continue;
    let found = false;
    for (const val of Object.values(v.valuesByMode)) {
      if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && val.id === remoteVarId) { found = true; break; }
    }
    if (found) {
      referencedBy.push({
        id:             v.id,
        name:           v.name,
        resolvedType:   v.resolvedType,
        collectionName: coll.name,
        hex:            v.resolvedType === 'COLOR' ? resolveHex(v.id) : null,
      });
    }
  }
  referencedBy.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const remoteVar  = _varById.get(remoteVarId);
  const remoteColl = remoteVar ? _collById.get(remoteVar.variableCollectionId) : null;
  figma.ui.postMessage({
    type:          'referenced-by',
    remoteVarId,
    remoteVarName: remoteVar  ? remoteVar.name  : remoteVarId,
    remoteType:    remoteVar  ? remoteVar.resolvedType : 'UNKNOWN',
    remoteHex:     remoteVar  && remoteVar.resolvedType === 'COLOR' ? resolveHex(remoteVarId) : null,
    remoteCollName: remoteColl ? remoteColl.name : '',
    referencedBy,
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

async function getStylesUsingVar(variableId) {
  const matches = [];

  function matchesVar(binding) {
    if (!binding) return false;
    if (Array.isArray(binding)) return binding.some(b => b && b.id === variableId);
    return binding.id === variableId;
  }
  function checkBoundVars(bv) {
    if (!bv) return false;
    return Object.values(bv).some(matchesVar);
  }

  const [textStyles, paintStyles, effectStyles] = await Promise.all([
    figma.getLocalTextStylesAsync(),
    figma.getLocalPaintStylesAsync(),
    figma.getLocalEffectStylesAsync(),
  ]);

  for (const s of textStyles) {
    if (checkBoundVars(s.boundVariables)) matches.push({ id: s.id, name: s.name, type: 'TEXT' });
  }
  for (const s of paintStyles) {
    let found = checkBoundVars(s.boundVariables);
    if (!found) { for (const p of s.paints) { if (p.boundVariables && matchesVar(p.boundVariables.color)) { found = true; break; } } }
    if (found) matches.push({ id: s.id, name: s.name, type: 'PAINT' });
  }
  for (const s of effectStyles) {
    let found = checkBoundVars(s.boundVariables);
    if (!found) { for (const e of s.effects || []) { if (checkBoundVars(e.boundVariables)) { found = true; break; } } }
    if (found) matches.push({ id: s.id, name: s.name, type: 'EFFECT' });
  }
  return matches;
}

// ─── Remote chain helpers ─────────────────────────────────────────────────────

/** Finds all local variable IDs that directly alias the given remote variable. */
function getRemoteDescendantIds(remoteVarId) {
  const ids = [];
  for (const [localId, v] of _varById) {
    if (!_localVarIds.has(localId)) continue;
    for (const val of Object.values(v.valuesByMode)) {
      if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && val.id === remoteVarId) {
        ids.push(localId);
        break;
      }
    }
  }
  return ids;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function computeAllImpactScores() {
  const scores = {};

  // Score all known variables — local first, then any non-local that have component bindings
  const idsToScore = new Set(_localVarIds);
  for (const varId of _componentsByVarId.keys()) idsToScore.add(varId);

  for (const id of idsToScore) {
    const varDeps = _descendantCounts.get(id) || 0;
    const hasDesc = varDeps > 0;
    let ancDepth = 0;
    const vis = new Set([id]); let cur = id;
    while (true) {
      const t = _aliasMap.get(cur); if (!t || t.size === 0) break;
      const nxt = t.values().next().value; if (vis.has(nxt)) break;
      vis.add(nxt); ancDepth++; cur = nxt;
    }
    // Count components transitively: include components bound to any alias descendant,
    // not just direct bindings. Primitives with no direct bindings but many alias
    // consumers would otherwise score 0 and appear as "Unused".
    const descIds = new Set([id]);
    const bfsQ = [id]; let bfsH = 0;
    while (bfsH < bfsQ.length) {
      const cur2 = bfsQ[bfsH++];
      const ch = _reverseAliasMap.get(cur2);
      if (ch) for (const c of ch) if (!descIds.has(c)) { descIds.add(c); bfsQ.push(c); }
    }
    const transitiveComps = new Set();
    for (const descId of descIds) {
      const comps = _componentsByVarId.get(descId);
      if (comps) for (const c of comps) transitiveComps.add(c);
    }
    const compCount = transitiveComps.size;
    const mult = (ancDepth > 0 && hasDesc) ? 1.5 : ancDepth > 0 ? 1.0 : 0.5;
    // Impact = what depends on the token (descendant alias tokens + components), never
    // its own upward alias depth. A token referenced by nothing scores 0 → "Unused",
    // not "Low". (mult still uses ancDepth for chain-position weighting; the additive
    // ancDepth*2 term was what wrongly lifted zero-reference tokens above 0.)
    scores[id] = Math.round(((varDeps * 6) + (compCount * 4)) * mult);
  }
  return scores;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// Reconcile the cached library variables against the live library. Library variables
// live in ANOTHER file, so renaming, deleting or republishing one there leaves this
// file's cache signature untouched and the cache still looks valid. Per cached entry:
//   id resolves     → take the LIVE name (a rename otherwise shows up twice)
//   id returns null → deleted or unpublished, so drop it
//   id throws       → transient; keep what we had rather than wipe the user's data
// Then add anything newly aliased from this file, and collapse on the library key —
// the only stable identity, since the id is per-file.
async function reconcileCachedLibraryVars(cachedScan) {
  const cached = cachedScan.remoteVars || [];
  const verified = await Promise.all(cached.map((rv) =>
    figma.variables.getVariableByIdAsync(rv.id)
      .then((live) => {
        if (!live) return null;
        _varById.set(live.id, live);            // the real entry beats the seeded stub
        return Object.assign({}, rv, { name: live.name, resolvedType: live.resolvedType });
      })
      .catch(() => rv)
  ));

  let remoteVars = [];
  for (let i = 0; i < verified.length; i++) {
    if (verified[i]) { remoteVars.push(verified[i]); continue; }
    _varById.delete(cached[i].id);
    _componentsByVarId.delete(cached[i].id);
  }
  let remoteColls = cachedScan.remoteColls || [];

  let discovered = null;
  try { discovered = await discoverRemoteVarsFromAliases(); } catch (_) {}
  if (discovered) {
    for (const fv of discovered.remoteVars) {
      const at = remoteVars.findIndex((rv) => rv.id === fv.id);
      if (at === -1) remoteVars.push(fv); else remoteVars[at] = fv;
    }
    const collIds = new Set(remoteColls.map((c) => c.id));
    for (const fc of discovered.remoteColls) if (!collIds.has(fc.id)) remoteColls.push(fc);
  }

  const liveNames = new Map();
  try {
    const lib = await enumerateAllLibraryVars();
    for (const lv of lib.libVars) if (lv.libraryKey) liveNames.set(lv.libraryKey, lv.name);
  } catch (_) {}

  return { remoteVars: dedupeRemoteVarsByKey(remoteVars, liveNames), remoteColls };
}

async function handleInit(force) {
  try {
    // ── Phase 1a: local variables + styles (0% → 20%) ────────────────────────
    // Variables + collections first: the cache key is derived from them when
    // figma.fileKey is unavailable (Professional seats — the same user may run
    // this on Enterprise seats where fileKey IS set, and on multiple accounts).
    const [allVars, allColls] = await Promise.all([
      figma.variables.getLocalVariablesAsync(),
      figma.variables.getLocalVariableCollectionsAsync(),
    ]);
    // figma.fileKey is undefined for dev plugins on non-Enterprise seats, and
    // figma.root.name/id don't identify the file, so a fixed fallback key would
    // make EVERY file share one cache bucket. Put a content signature IN the key
    // so each distinct file gets its own slot on any seat; a matching signature
    // is still verified below before the cache is trusted.
    const _fileSig = fileSigFrom(allVars, allColls);
    // Stable key; correctness comes from the _fileSig check below, which holds on
    // every seat (fileKey is absent on non-Enterprise ones). Alternating between
    // files re-scans rather than serving the wrong cache.
    const _initCacheKey = 'scan-' + (figma.fileKey || 'local');
    const [textStyles, paintStyles, effectStyles, lastScanDepth, libColls, _rawCachedScan] = await Promise.all([
      figma.getLocalTextStylesAsync(),
      figma.getLocalPaintStylesAsync(),
      figma.getLocalEffectStylesAsync(),
      figma.clientStorage.getAsync('scan-depth').catch(() => null),
      figma.teamLibrary && figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync
        ? figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync().catch(() => [])
        : Promise.resolve([]),
      figma.clientStorage.getAsync(_initCacheKey).catch(() => null),
    ]);
    // An explicit rescan must re-read the file, not replay the cache. Library
    // variables live in another file, so a rename there leaves this file's
    // signature untouched — without this, a rescan re-served the old names.
    const validCachedScan = force ? null :
      (_rawCachedScan && _rawCachedScan.version === 2 && _rawCachedScan._fileSig === _fileSig)
        ? _rawCachedScan : null;
    // Send progress now that we know whether a cache exists — UI suppresses the bar if hasCachedScan
    figma.ui.postMessage({ type: 'init-progress', pct: 0, hasCachedScan: !!validCachedScan, cachedDepth: validCachedScan ? validCachedScan.depth : null });
    // Base signal from the library API — unreliable on its own: it misses
    // libraries that are used but not formally added to the file. Augmented below
    // with a cheap, reliable local signal once the alias maps are built.
    let hasExternalLibraries = Array.isArray(libColls) && libColls.length > 0;

    _collById = new Map(allColls.map(c => [c.id, c]));
    buildAliasMaps(allVars);
    _descendantCounts = buildDescendantCountMap();
    _localVarIds = new Set(_varById.keys());

    // A local variable that aliases an external target proves the file references
    // an external library — detectable at init without any library API call.
    // (Files whose only external usage is instances of remote components can't be
    // detected this cheaply; a Full scan surfaces those and flips the flag then.)
    if (_externalAliasMap.size > 0) hasExternalLibraries = true;

    // Style count per variable (for list badge)
    const styleCountMap = new Map();
    function incStyle(id) { if (id) styleCountMap.set(id, (styleCountMap.get(id) || 0) + 1); }
    function scanBV(bv) {
      if (!bv) return;
      for (const b of Object.values(bv)) {
        if (Array.isArray(b)) { for (const x of b) { if (x && x.id) incStyle(x.id); } }
        else if (b && b.id) incStyle(b.id);
      }
    }
    for (const s of textStyles) scanBV(s.boundVariables);
    for (const s of paintStyles) {
      scanBV(s.boundVariables);
      for (const p of s.paints) { if (p.boundVariables && p.boundVariables.color) incStyle(p.boundVariables.color.id); }
    }
    for (const s of effectStyles) {
      scanBV(s.boundVariables);
      for (const e of s.effects || []) scanBV(e.boundVariables);
    }

    const variables   = allVars.map(v => ({
      id:                   v.id,
      name:                 v.name,
      resolvedType:         v.resolvedType,
      variableCollectionId: v.variableCollectionId,
      hex:                  v.resolvedType === 'COLOR' ? resolveHex(v.id) : null,
      dependentCount:       (_descendantCounts.get(v.id) || 0) + (styleCountMap.get(v.id) || 0),
      hasExternalAlias:     _externalAliasMap.has(v.id),
    }));
    const collections = allColls.map(c => ({ id: c.id, name: c.name, modes: c.modes }));

    // ── Fast path: cache hit with browserComponents → skip index build ────────
    if (validCachedScan && validCachedScan.browserComponents) {
      _seedRemoteVarsFromCache(validCachedScan.remoteVars, validCachedScan.remoteColls);
      _populateIndexFromCache(validCachedScan.browserComponents);
      const { remoteVars: _remoteVars, remoteColls: _remoteColls } =
        await reconcileCachedLibraryVars(validCachedScan);
      _componentIndexBuilt   = true;
      _componentBrowserCache = validCachedScan.browserComponents;
      // Recompute counts and impact scores from the live alias graph + freshly-populated
      // index rather than serving the cached values. Cached scores can be stale — from an
      // earlier scan or an older impact formula — which mislabels a token with no
      // dependents or components as "Low" instead of "Unused". The tier must reflect the
      // same live data the detail panel reads, so the two can never disagree.
      const freshComponentCounts = {};
      for (const [vid, compIds] of _componentsByVarId.entries()) freshComponentCounts[vid] = compIds.size;
      const freshImpactScores = computeAllImpactScores();
      figma.ui.postMessage({
        type: 'init-data', variables, collections,
        remoteVars:           _remoteVars,
        remoteColls:          _remoteColls,
        componentIndexBuilt:  true,
        varComponentCounts:   freshComponentCounts,
        varImpactScores:      freshImpactScores,
        lastScanDepth:        validCachedScan.depth || null,
        hasExternalLibraries: _remoteVars.length > 0,
        browserComponents:    validCachedScan.browserComponents,
        cachedScan:           validCachedScan,
      });
      return;
    }

    // ── Phase 1b: local component index (20% → 90%) ──────────────────────────
    // Remote/library variable discovery is deferred to the Full Scan (user-triggered).
    figma.ui.postMessage({ type: 'init-progress', pct: 20 });
    if (_initCancelled) return;
    await buildLocalComponentIndex();
    if (_initCancelled) return;
    _componentIndexBuilt = true;

    let remoteVars = [];
    let remoteColls = [];

    // Component counts per variable
    const varComponentCounts = {};
    for (const [varId, compIds] of _componentsByVarId.entries()) {
      varComponentCounts[varId] = compIds.size;
    }

    // Impact scores
    const varImpactScores = computeAllImpactScores();

    // Build component browser list
    const compToVars = new Map();
    for (const [varId, compIds] of _componentsByVarId.entries()) {
      for (const cid of compIds) {
        if (!compToVars.has(cid)) compToVars.set(cid, new Set());
        compToVars.get(cid).add(varId);
      }
    }
    const browserComponents = [];
    for (const [cid, varIds] of compToVars.entries()) {
      const meta = _componentById.get(cid);
      if (!meta) continue;
      const boundVars = [...varIds].filter(vid => _varById.has(vid)).map(vid => {
        const v = _varById.get(vid);
        return { id: vid, name: v.name, resolvedType: v.resolvedType };
      }).sort((a, b) => a.name.localeCompare(b.name));
      browserComponents.push({
        nodeId: cid, nodeName: meta.name, nodeType: meta.type,
        pageName: meta.pageName, pageId: meta.pageId,
        boundCount: varIds.size, boundVars,
      });
    }
    browserComponents.sort((a, b) =>
      b.boundCount - a.boundCount ||
      a.pageName.localeCompare(b.pageName) ||
      a.nodeName.localeCompare(b.nodeName)
    );
    _componentBrowserCache = browserComponents;

    figma.ui.postMessage({
      type: 'init-data', variables, collections,
      remoteVars, remoteColls,
      componentIndexBuilt: true, varComponentCounts, varImpactScores,
      lastScanDepth: lastScanDepth || null,
      hasExternalLibraries,
      browserComponents,
      cachedScan: validCachedScan, // bundled so UI can restore in the same tick as init
    });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message });
  }
}

async function handleAnalyze(variableId) {
  try {
    const chain      = await buildChain(variableId);
    const styles     = await getStylesUsingVar(variableId);
    const varIds     = [variableId, ...chain.descendants.map(d => d.id)];
    const components = _componentIndexBuilt ? lookupComponents(varIds, variableId) : null;
    const compCount  = components ? components.length : null;
    const impact     = computeImpact(variableId, chain, compCount);
    figma.ui.postMessage({ type: 'chain-result', chain, styles, components, impact });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message });
  }
}


async function handleAnalyzeRemote(remoteVarId, varName, resolvedType, collectionName) {
  try {
    const remoteVar  = _varById.get(remoteVarId);
    const remoteColl = remoteVar ? _collById.get(remoteVar.variableCollectionId) : null;
    const self = {
      id:             remoteVarId,
      name:           remoteVar ? remoteVar.name : (varName || remoteVarId),
      resolvedType:   remoteVar ? remoteVar.resolvedType : (resolvedType || 'UNKNOWN'),
      collectionName: remoteColl ? remoteColl.name : (collectionName || ''),
      depth:          0, isCyclic: false, isExternal: true, aliasModes: [], totalModes: 0, hasChildren: false,
      hex:            remoteVar && remoteVar.resolvedType === 'COLOR' ? resolveHex(remoteVarId) : null,
    };

    const descIds = getRemoteDescendantIds(remoteVarId);
    const descendants = descIds.map(localId => {
      const v    = _varById.get(localId);
      const coll = v ? _collById.get(v.variableCollectionId) : null;
      return {
        id:             localId,
        name:           v ? v.name : localId,
        resolvedType:   v ? v.resolvedType : 'UNKNOWN',
        collectionName: coll ? coll.name : '',
        depth: 1, isCyclic: false, isExternal: false, aliasModes: [], totalModes: coll ? coll.modes.length : 0, hasChildren: false,
        hex: v && v.resolvedType === 'COLOR' ? resolveHex(localId) : null,
      };
    });
    descendants.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    const ancestors  = await getAncestors(remoteVarId);
    const chain      = { selectedId: remoteVarId, ancestors, self, descendants };
    const varIds     = [remoteVarId, ...descIds];
    const components = _componentIndexBuilt ? lookupComponents(varIds, remoteVarId) : null;
    figma.ui.postMessage({ type: 'chain-result', chain, styles: [], components, impact: { score: 0, tier: 'none' } });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message });
  }
}

async function handleBuildComponentIndexRemote(remoteVarId) {
  try {
    if (!_componentIndexBuilt) figma.ui.postMessage({ type: 'index-progress', text: 'Loading pages…' });
    await ensureComponentIndex();

    const descIds    = getRemoteDescendantIds(remoteVarId);
    const varIds     = [remoteVarId, ...descIds];
    const components = lookupComponents(varIds, remoteVarId);

    const varComponentCounts = {};
    for (const [varId, compIds] of _componentsByVarId.entries()) {
      varComponentCounts[varId] = compIds.size;
    }

    const remoteVars  = [];
    const remoteColls = [];
    const seenCollIds = new Set();
    for (const [varId, compIds] of _componentsByVarId.entries()) {
      if (_localVarIds.has(varId)) continue;
      const v    = _varById.get(varId);
      const coll = v ? _collById.get(v.variableCollectionId) : null;
      if (!v) continue;
      remoteVars.push({
        id: v.id, libraryKey: v.key || null, name: v.name,
        resolvedType: v.resolvedType, variableCollectionId: v.variableCollectionId,
        hex: v.resolvedType === 'COLOR' ? resolveHex(v.id) : null,
        dependentCount: compIds.size, isRemote: true,
      });
      if (coll && !seenCollIds.has(coll.id)) {
        seenCollIds.add(coll.id);
        remoteColls.push({ id: coll.id, name: coll.name, modes: coll.modes, isRemote: true });
      }
    }

    const varImpactScores = computeAllImpactScores();

    figma.ui.postMessage({ type: 'index-ready', components, impact: { score: 0, tier: 'none' }, remoteVars, remoteColls, varComponentCounts, varImpactScores });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message });
  }
}

// Cheap per-file signature to scope the scan cache when figma.fileKey is
// unavailable (local/dev plugins on non-Enterprise plans). figma.root.name is
// always "Document" and figma.root.id is always "0:0", so neither identifies the
// file — instead fingerprint the actual token/collection set. Two files with
// different variables get different signatures, so one file's cache is never
// served for another. (Exact duplicates share a signature, which is harmless —
// identical content scans identically.)
function fileSigFrom(vars, colls) {
  const names =
    vars.map(v => v.name).sort().join(',') + '||' +
    colls.map(c => c.name).sort().join(',');
  let h = 0;
  for (let i = 0; i < names.length; i++) h = ((h << 5) - h + names.charCodeAt(i)) | 0;
  return figma.root.children.length + ':' + vars.length + ':' +
    colls.length + ':' + (h >>> 0).toString(36);
}

async function handleFocusNode(nodeId, pageId) {
  try {
    // documentAccess: dynamic-page — getNodeByIdAsync returns null for a node on
    // a page that isn't loaded. The UI sends the node's pageId; load that page
    // first, or a valid LOCAL component silently fails to focus and looks like a
    // library component with no canvas location.
    if (pageId) {
      // A page is a node — getNodeByIdAsync, not a getPageByIdAsync (that API
      // does not exist; calling it threw and made every focus click fail).
      const page = await figma.getNodeByIdAsync(pageId);
      if (page && page.type === 'PAGE') await page.loadAsync();
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      // Genuinely unreachable — the master lives in an external library, so it has
      // no canvas location. Tell the user instead of doing nothing.
      figma.ui.postMessage({ type: 'focus-unavailable', nodeId: nodeId });
      return;
    }
    let p = node;
    while (p && p.type !== 'PAGE') p = p.parent;
    if (p && p !== figma.currentPage) await figma.setCurrentPageAsync(p);
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
  } catch (_) {
    figma.ui.postMessage({ type: 'focus-unavailable', nodeId: nodeId });
  }
}

// ─── Place affected components on canvas ──────────────────────────────────────
// Builds an "audit board": one frame holding a live instance of every component
// the selected token affects, so the impact can be reviewed side by side before
// the token changes. Instances (not clones) — editing the token afterwards
// updates the board in place.
//
// Boards live on a plugin-owned page rather than the current one: generated
// content dropped at the viewport would land on top of whatever the designer is
// working on, and repeat runs would pile up on each other.

const BOARD_PAGE_KEY = 'impact-atlas-boards';
const MAX_PLACE = 200; // components already arrive sorted most-bound-first

const BOARD_PAGE_NAME = 'Impact Atlas Previews';

// Returns { page, created }. created=true only when this call had to make the
// page — i.e. no previous placements existed. That flag lets a cancel/failure
// clean up a page it just created without ever removing one that already holds
// earlier placements.
async function ensureBoardsPage() {
  for (const p of figma.root.children) {
    try {
      if (p.getPluginData(BOARD_PAGE_KEY) === '1') {
        // Rename pages tagged by earlier versions, so old files stay consistent.
        if (p.name !== BOARD_PAGE_NAME) { try { p.name = BOARD_PAGE_NAME; } catch (_) {} }
        return { page: p, created: false };
      }
    } catch (_) {}
  }
  const page = figma.createPage();
  page.name = BOARD_PAGE_NAME;
  try { page.setPluginData(BOARD_PAGE_KEY, '1'); } catch (_) {}
  return { page, created: true };
}

// Undo a boards page this run created, when a cancel or failure leaves it empty.
// Never touches a pre-existing page (created=false) — that one holds previous
// placements the user asked us to keep.
async function removeBoardsPageIfCreatedEmpty(page, created) {
  if (!created) return;
  try {
    if (page.children.length > 0) return;             // something else landed — keep it
    if (figma.currentPage === page) {                 // can't remove the active page
      const other = figma.root.children.find(p => p !== page);
      if (other) await figma.setCurrentPageAsync(other);
    }
    page.remove();
  } catch (_) {}
}

// Local masters instance directly; library ones are imported by key first.
// Returns null when the component can't be resolved — the caller skips it
// instead of failing the whole run.
async function instantiateComponent(nodeId) {
  let comp = null;
  try { comp = await figma.getNodeByIdAsync(nodeId); } catch (_) { return null; }
  if (!comp) return null;
  if (comp.type === 'COMPONENT_SET') {
    comp = comp.defaultVariant || (comp.children && comp.children[0]) || null;
  }
  if (!comp || comp.type !== 'COMPONENT') return null;
  if (comp.remote && comp.key) {
    try { comp = await figma.importComponentByKeyAsync(comp.key); } catch (_) {}
  }
  try { return comp.createInstance(); } catch (_) { return null; }
}


async function handlePlaceComponents(msg) {
  const all   = (msg && Array.isArray(msg.components)) ? msg.components : [];
  const list  = all.slice(0, MAX_PLACE);
  // Group by name so related components (and their variants) sit together on the
  // board. The slice above already kept the most-impactful ones; this only
  // reorders how those are laid out.
  list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const total = list.length;
  let section = null;
  let page = null, pageCreated = false; // hoisted so the catch can clean up too

  const GAP = 48;  // auto-layout spacing between instances
  const PAD = 64;  // inset from the section edges

  try {
    if (total === 0) {
      figma.ui.postMessage({ type: 'place-error', message: 'Nothing to place' });
      return;
    }

    ({ page, created: pageCreated } = await ensureBoardsPage());
    await page.loadAsync();

    // A Section so its name — the token + date/time — is visible on the canvas
    // itself, not just in the layers panel. Transparent (adds no colour). A single
    // transparent auto-layout frame inside wraps the instances to a narrow set of
    // columns and reflows if the token later changes their sizes.
    section = figma.createSection();
    section.name = 'Impact — ' + (msg.title || 'components') + (msg.date ? '  ·  ' + msg.date : '');
    try { section.fills = []; } catch (_) {}
    page.appendChild(section);
    section.x = 0;
    section.y = 0;

    const board = figma.createFrame();
    board.name       = 'Components';
    board.layoutMode = 'HORIZONTAL';
    board.layoutWrap = 'WRAP';
    board.primaryAxisSizingMode = 'AUTO';
    board.counterAxisSizingMode = 'AUTO';
    board.counterAxisAlignItems = 'MIN';
    board.itemSpacing        = GAP;
    board.counterAxisSpacing = GAP;
    board.fills        = [];
    board.clipsContent = false;
    section.appendChild(board);
    board.x = PAD;
    board.y = PAD;

    const instances = [];
    let skipped = 0, maxW = 1;
    const startTs = Date.now();

    for (let i = 0; i < total; i++) {
      const instance = await instantiateComponent(list[i].nodeId);
      if (instance) {
        board.appendChild(instance);
        instances.push(instance);
        if (typeof instance.width === 'number' && instance.width > maxW) maxW = instance.width;
      } else {
        skipped++;
      }

      // Report progress every instance (with a rough ETA) and yield each time, so
      // the bar advances smoothly and Cancel stays responsive — instead of jumping
      // in big steps, which reads as "stuck".
      const done = i + 1;
      let eta = '';
      if (done >= 2 && done < total) {
        const secs = Math.round(((Date.now() - startTs) / done) * (total - done) / 1000);
        if (secs > 0) eta = secs >= 60 ? ('~' + Math.floor(secs / 60) + 'm ' + (secs % 60) + 's left') : ('~' + secs + 's left');
      }
      figma.ui.postMessage({ type: 'place-progress', done, total, eta });
      await yieldTick();
      if (_placeCancelled) {
        section.remove();
        await removeBoardsPageIfCreatedEmpty(page, pageCreated);
        figma.ui.postMessage({ type: 'place-cancelled' });
        return;
      }
    }

    const placed = instances.length;
    if (placed === 0) {
      section.remove();
      await removeBoardsPageIfCreatedEmpty(page, pageCreated);
      figma.ui.postMessage({ type: 'place-error', message: "Couldn't place any components" });
      return;
    }

    // Sort by height (tallest first) and re-append in that order. Auto-layout gives
    // every wrapped row the height of its tallest item, so grouping similar heights
    // together leaves far less empty space below shorter components.
    instances.sort((a, b) => ((b.height || 0) - (a.height || 0)));
    for (let k = 0; k < placed; k++) board.appendChild(instances[k]);

    // Fix the frame to a ~2000px width so instances wrap into several columns
    // (widened at least to the single widest component). Guarded: a rejected resize
    // leaves a usable single row rather than losing every instance.
    try {
      const BOARD_W = 2000;
      board.primaryAxisSizingMode = 'FIXED';
      board.resize(Math.max(BOARD_W, maxW), Math.max(1, board.height));
    } catch (_) {}

    // Size the section to wrap the frame plus a uniform inset.
    try {
      section.resizeWithoutConstraints(board.width + PAD * 2, board.height + PAD * 2);
    } catch (_) {}

    // Move the section to the right of anything already on the page — sections sit
    // side by side and never overlap, so repeat placements line up left to right.
    let maxRight = null;
    for (const child of page.children) {
      if (child === section) continue;
      if (typeof child.x !== 'number' || typeof child.width !== 'number') continue;
      const right = child.x + child.width;
      if (maxRight === null || right > maxRight) maxRight = right;
    }
    section.x = maxRight === null ? 0 : Math.round(maxRight + 200);
    section.y = 0;

    await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = [section];
    figma.viewport.scrollAndZoomIntoView([section]);

    figma.ui.postMessage({
      type: 'place-done',
      placed, skipped,
      truncated: all.length - total,
      pageName:  page.name,
    });
  } catch (err) {
    if (section) { try { section.remove(); } catch (_) {} }
    if (page) await removeBoardsPageIfCreatedEmpty(page, pageCreated);
    figma.ui.postMessage({ type: 'place-error', message: err.message });
  }
}

// Re-read local variables + collections and rebuild the alias/descendant maps, then
// return the UI payload {variables, collections}. The variable list is otherwise only
// built at init, so without this a rescan can't reflect variables added, renamed, or
// deleted since the plugin opened — they'd persist until a full restart.
async function refreshLocalVariablePayload() {
  const [allVars, allColls, textStyles, paintStyles, effectStyles] = await Promise.all([
    figma.variables.getLocalVariablesAsync(),
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalPaintStylesAsync(),
    figma.getLocalEffectStylesAsync(),
  ]);
  _collById         = new Map(allColls.map(c => [c.id, c]));
  buildAliasMaps(allVars);
  _descendantCounts = buildDescendantCountMap();
  _localVarIds      = new Set(_varById.keys());

  const styleCountMap = new Map();
  const inc    = id => { if (id) styleCountMap.set(id, (styleCountMap.get(id) || 0) + 1); };
  const scanBV = bv => { if (!bv) return; for (const b of Object.values(bv)) { if (Array.isArray(b)) { for (const x of b) if (x && x.id) inc(x.id); } else if (b && b.id) inc(b.id); } };
  for (const s of textStyles)   scanBV(s.boundVariables);
  for (const s of paintStyles)  { scanBV(s.boundVariables); for (const p of s.paints) if (p.boundVariables && p.boundVariables.color) inc(p.boundVariables.color.id); }
  for (const s of effectStyles) { scanBV(s.boundVariables); for (const e of s.effects || []) scanBV(e.boundVariables); }

  const variables = allVars.map(v => ({
    id:                   v.id,
    name:                 v.name,
    resolvedType:         v.resolvedType,
    variableCollectionId: v.variableCollectionId,
    hex:                  v.resolvedType === 'COLOR' ? resolveHex(v.id) : null,
    dependentCount:       (_descendantCounts.get(v.id) || 0) + (styleCountMap.get(v.id) || 0),
    hasExternalAlias:     _externalAliasMap.has(v.id),
  }));
  const collections = allColls.map(c => ({ id: c.id, name: c.name, modes: c.modes }));
  return { variables, collections };
}

// A library variable's KEY is its stable identity; its id is per-file. When a file
// is subscribed to an older publish of the library, the id bound on canvas resolves
// to the old NAME while the library enumeration reports the new one — the same
// variable, twice, under two names. Collapse by key: keep the entry that is
// actually used (so impact and component links survive) and take the name from the
// live library when it is known.
function dedupeRemoteVarsByKey(remoteVars, liveNameByKey) {
  const byKey = new Map();
  const out   = [];
  for (const rv of remoteVars) {
    if (!rv.libraryKey) { out.push(rv); continue; }   // no key — nothing to match on
    const seen = byKey.get(rv.libraryKey);
    if (!seen) { byKey.set(rv.libraryKey, rv); out.push(rv); continue; }
    // Prefer whichever entry has real usage; that id is the one components reference.
    const usage = (v) => (v.aliasCount || 0) + (v.dependentCount || 0) +
      (_componentsByVarId.has(v.id) ? _componentsByVarId.get(v.id).size : 0);
    if (usage(rv) > usage(seen)) {
      const at = out.indexOf(seen);
      if (at !== -1) out[at] = rv;
      byKey.set(rv.libraryKey, rv);
    }
  }
  // The library is the authority on the current name.
  for (const rv of out) {
    if (rv.libraryKey && liveNameByKey.has(rv.libraryKey)) rv.name = liveNameByKey.get(rv.libraryKey);
  }
  return out;
}

async function handleUsageScan(msg) {
  const depth = (msg && msg.depth >= 2) ? msg.depth : 3;
  try {
    // Refresh the variable list + alias maps first so this scan reflects the current
    // file (added / renamed / deleted variables), not the stale set captured at init.
    const refreshedVarPayload = await refreshLocalVariablePayload();
    // ── Phase 2a: remote / library variable discovery ─────────────────────────
    figma.ui.postMessage({ type: 'usage-scan-progress', pct: 0 });

    let remoteVars = [];
    let remoteColls = [];
    const liveNameByKey = new Map(); // libraryKey → current name as the library publishes it
    try {
      const [discovered, allLib] = await Promise.all([
        discoverRemoteVarsFromAliases(),
        enumerateAllLibraryVars(),
      ]);
      for (const lv of allLib.libVars) if (lv.libraryKey) liveNameByKey.set(lv.libraryKey, lv.name);
      const seenKeys = new Set();
      for (const rv of discovered.remoteVars) {
        if (rv.libraryKey) seenKeys.add(rv.libraryKey);
        remoteVars.push(rv);
      }
      for (const lv of allLib.libVars) {
        if (lv.libraryKey && seenKeys.has(lv.libraryKey)) continue;
        remoteVars.push(lv);
      }
      const seenCollKeys = new Set();
      for (const rc of discovered.remoteColls) {
        if (rc.key) seenCollKeys.add(rc.key);
        remoteColls.push(rc);
      }
      for (const lc of allLib.libColls) {
        if (lc.key && seenCollKeys.has(lc.key)) continue;
        remoteColls.push(lc);
      }
    } catch (_) {}
    if (_scanCancelled) { figma.ui.postMessage({ type: 'usage-scan-cancelled' }); return; }

    // ── Canvas instance scan (counts + library component discovery) ───────────
    // Runs for any user-triggered Extended/Full scan. Discovery must NOT be gated
    // on library-collection availability: a file can USE a library (instances that
    // reference its variables) without that library being formally added, in which
    // case getAvailableLibraryVariableCollectionsAsync reports nothing. We still
    // find those referenced-remote tokens by resolving the instance bindings below.
    let instObj = {}, directObj = {}, scanTotal = 0, newLibraryComponents = [];
    if (depth >= 2) {
    await figma.loadAllPagesAsync();

    const pages = figma.root.children;

    // Count total INSTANCE nodes per page — pages phase = first 15%
    let total = 0;
    for (let pi = 0; pi < pages.length; pi++) {
      figma.ui.postMessage({ type: 'usage-scan-progress', pct: Math.round(((pi + 1) / pages.length) * 15) });
      await yieldTick();
      total += pages[pi].findAllWithCriteria({ types: ['INSTANCE'] }).length;
    }

    // Map published-component key → its local master node. A design-system SOURCE
    // file that also consumes its own published library ends up with BOTH a local
    // master AND remote instances of the same component. They share a published
    // `key`, so collapsing the remote ones onto the local master below avoids
    // listing the component twice (once local, once as a "library" duplicate).
    // Rebuild the component index from scratch — a full scan is the authoritative
    // snapshot. Inheriting the cache-restored index risks stale duplicates (old
    // library twins, or variants indexed individually before variant rollup). We
    // re-index local masters here (rolling variants up to their COMPONENT_SET) and
    // Pass 1 below augments this with library components actually used on canvas.
    _componentById     = new Map();
    _componentsByVarId = new Map();
    const localMasterByKey = new Map();
    for (const page of pages) {
      const masters = page.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
      for (const m of masters) {
        if (m.type === 'COMPONENT' && m.parent && m.parent.type === 'COMPONENT_SET') continue; // roll up to the set
        if (!m.remote && m.key && !localMasterByKey.has(m.key)) localMasterByKey.set(m.key, m);

        const mVarIds = new Set();
        collectNodeVarIds(m, mVarIds);
        const mDesc = m.findAllWithCriteria({ types: BINDING_TYPES });
        for (let d = 0; d < mDesc.length; d++) collectNodeVarIds(mDesc[d], mVarIds);
        if (mVarIds.size === 0) continue;

        const mRemote = !!m.remote;
        _componentById.set(m.id, {
          name: m.name, type: m.type,
          pageName: mRemote ? 'Library' : page.name,
          pageId:   mRemote ? null : page.id,
          isRemote: mRemote,
        });
        for (const vid of mVarIds) {
          if (!_componentsByVarId.has(vid)) _componentsByVarId.set(vid, new Set());
          _componentsByVarId.get(vid).add(m.id);
        }
      }
      await yieldTick();
    }

    // instanceCounts: varId → number of canvas instances that use it (via mainComponent)
    // directCounts:   varId → number of non-instance canvas nodes that directly bind it
    const instanceCounts = new Map();
    const directCounts   = new Map();
    let scanned = 0;

    const compCache = new Map(); // cacheKey → Set<varId>
    // compInfo: cacheKey → { id, name, type, isRemote, instanceCount, varIds }
    // Per-component metadata so the Components view can list every component
    // encountered on canvas (local + library) with instance counts.
    const compInfo  = new Map();

    // Per-scan visibility cache. Siblings share parent chains, so memoising
    // by node id avoids re-walking the same ancestors for every instance.
    const visCache = new Map(); // nodeId → boolean

    function isEffectivelyVisible(node) {
      let n = node;
      const chain = [];
      while (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
        if (visCache.has(n.id)) {
          const cached = visCache.get(n.id);
          for (const id of chain) visCache.set(id, cached);
          return cached;
        }
        if (n.visible === false) {
          for (const id of chain) visCache.set(id, false);
          visCache.set(n.id, false);
          return false;
        }
        chain.push(n.id);
        n = n.parent;
      }
      for (const id of chain) visCache.set(id, true);
      return true;
    }

    // ── Pass 2 helper: walk page children but stop at INSTANCE nodes — their
    // bindings are already captured in Pass 1. findAllWithCriteria would recurse
    // into instance subtrees causing massive double-counting, so we traverse the
    // tree manually and bail out whenever we hit an INSTANCE.
    // _scanVids is reused across every node to avoid one Set allocation per node;
    // each node fully consumes it before recursing into children, so sharing is safe.
    const _scanVids = new Set();
    function scanNonInstance(node) {
      if (node.type === 'INSTANCE') return; // stop — counted in Pass 1
      if (node.visible === false) return;   // skip hidden subtrees
      _scanVids.clear();
      collectNodeVarIds(node, _scanVids);
      for (const vid of _scanVids) directCounts.set(vid, (directCounts.get(vid) || 0) + 1);
      if (node.children) {
        for (let c = 0; c < node.children.length; c++) scanNonInstance(node.children[c]);
      }
    }

    const MC_BATCH = 50;
    for (const page of pages) {
      // ── Pass 1: instances ────────────────────────────────────────────────
      // getMainComponentAsync is an IPC round-trip per instance; batching with
      // Promise.all pipelines them instead of paying latency sequentially.
      const instances = page.findAllWithCriteria({ types: ['INSTANCE'] });
      const visible   = instances.filter(isEffectivelyVisible);
      // Invisible instances are skipped for processing but still counted toward
      // `scanned` so the progress bar reaches 100% (matches old per-instance ++).
      scanned += instances.length - visible.length;

      for (let bi = 0; bi < visible.length; bi += MC_BATCH) {
        const slice = visible.slice(bi, bi + MC_BATCH);
        const mcs   = await Promise.all(slice.map(i => i.getMainComponentAsync().catch(() => null)));

        scanned += slice.length;
        if (_scanCancelled) {
          figma.ui.postMessage({ type: 'usage-scan-cancelled' });
          return;
        }
        const pct = 15 + Math.round((scanned / total) * 85);
        figma.ui.postMessage({ type: 'usage-scan-progress', pct });
        await yieldTick();

        for (let j = 0; j < slice.length; j++) {
          const inst = slice[j];
          const mc   = mcs[j];
          if (!mc) continue;

          // Variant rollup: prefer the parent COMPONENT_SET id so variants of
          // the same set group under one entry (matches buildComponentIndex).
          let cacheNode = mc;
          if (mc.parent && mc.parent.type === 'COMPONENT_SET') cacheNode = mc.parent;
          // Collapse a remote instance onto its local master when both live here
          // (same published key) — otherwise the component shows up twice, and the
          // local one gets mislabelled as a library component.
          if (cacheNode.remote && cacheNode.key && localMasterByKey.has(cacheNode.key)) {
            cacheNode = localMasterByKey.get(cacheNode.key);
          }
          const cacheKey = cacheNode.id;

          if (!compCache.has(cacheKey)) {
            const varIds = new Set();
            let mcOk = false;
            try {
              collectNodeVarIds(cacheNode, varIds);
              const desc = cacheNode.findAllWithCriteria({ types: BINDING_TYPES });
              for (let d = 0; d < desc.length; d++) collectNodeVarIds(desc[d], varIds);
              mcOk = true;
            } catch (_) {}
            if (!mcOk) {
              // Fallback: scan instance subtree (explicit overrides only)
              collectNodeVarIds(inst, varIds);
              try {
                const instDesc = inst.findAllWithCriteria({ types: BINDING_TYPES });
                for (let d = 0; d < instDesc.length; d++) collectNodeVarIds(instDesc[d], varIds);
              } catch (_) {}
            }
            compCache.set(cacheKey, varIds);

            // Remote when the component's master lives in an external library.
            // Use the node's own `remote` flag — NOT "absent from the local index":
            // a local master that binds only remote tokens is skipped by the local
            // index yet is not remote, and must not be mislabelled as a library one.
            const isRemote = !!cacheNode.remote;

            // Index any component not already indexed (local masters the local pass
            // skipped, plus library components) so it shows up in impact analysis.
            // Local masters keep their real page; library masters live nowhere here.
            if (varIds.size > 0 && !_componentById.has(cacheKey)) {
              let pageName = 'Library', pageId = null;
              if (!isRemote) {
                let p = cacheNode.parent;
                while (p && p.type !== 'PAGE') p = p.parent;
                if (p) { pageName = p.name; pageId = p.id; }
              }
              _componentById.set(cacheKey, { name: cacheNode.name, type: cacheNode.type, pageName, pageId, isRemote });
              for (const vid of varIds) {
                if (!_componentsByVarId.has(vid)) _componentsByVarId.set(vid, new Set());
                _componentsByVarId.get(vid).add(cacheKey);
              }
            }

            compInfo.set(cacheKey, {
              id:            cacheKey,
              name:          cacheNode.name,
              type:          cacheNode.type,
              isRemote:      isRemote,
              instanceCount: 0,
              varIds:        varIds,
            });
          }

          // Only count instances at depth 3 (Full Analysis)
          if (depth >= 3) {
            const info = compInfo.get(cacheKey);
            if (info) info.instanceCount++;

            const varIds = compCache.get(cacheKey);
            if (varIds && varIds.size > 0) {
              for (const vid of varIds) {
                instanceCounts.set(vid, (instanceCounts.get(vid) || 0) + 1);
              }
            }
          }
        }
      }

      // ── Pass 2: raw layers outside instances with direct bindings (depth 3 only) ──
      if (depth >= 3) {
        for (let c = 0; c < page.children.length; c++) scanNonInstance(page.children[c]);
      }
    }

    // Serialise instance + direct counts
    for (const [k, v] of instanceCounts.entries()) instObj[k]   = v;
    for (const [k, v] of directCounts.entries())   directObj[k] = v;
    scanTotal = scanned;

    // Fetch any external var IDs referenced by discovered components but not yet in
    // _varById — from library components AND from local masters that bind remote
    // tokens. Must happen before building newLibraryComponents so boundVars resolve.
    const unknownCompIds = [];
    for (const [, info] of compInfo.entries()) {
      for (const vid of info.varIds) {
        if (!_localVarIds.has(vid) && !_varById.has(vid)) unknownCompIds.push(vid);
      }
    }
    if (unknownCompIds.length > 0) {
      const fetched = await Promise.all(
        unknownCompIds.map(id => figma.variables.getVariableByIdAsync(id).catch(() => null))
      );
      for (const v of fetched) {
        if (v) {
          _varById.set(v.id, v);
          if (v.variableCollectionId && !_collById.has(v.variableCollectionId)) {
            const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId).catch(() => null);
            if (c) _collById.set(c.id, c);
          }
        }
      }
    }

    // Merge library components discovered during scan into the global index
    for (const [cid, info] of compInfo.entries()) {
      if (!info.isRemote) continue; // local ones are already in the index
      if (!_componentById.has(cid)) {
        _componentById.set(cid, {
          name:     info.name,
          type:     info.type,
          pageName: 'Library',
          pageId:   null,
          isRemote: true,
        });
      }
      for (const varId of info.varIds) {
        if (!_componentsByVarId.has(varId)) _componentsByVarId.set(varId, new Set());
        _componentsByVarId.get(varId).add(cid);
      }
    }

    // Build serialisable list of newly discovered library components for the browser
    for (const [cid, info] of compInfo.entries()) {
      if (!info.isRemote) continue;
      const varIds = [...info.varIds];
      newLibraryComponents.push({
        nodeId:    cid,
        nodeName:  info.name,
        nodeType:  info.type,
        pageName:  'Library',
        pageId:    null,
        isRemote:  true,
        boundCount: varIds.filter(vid => _varById.has(vid)).length,
        boundVars:  varIds.filter(vid => _varById.has(vid)).map(vid => {
          const v = _varById.get(vid);
          return { id: vid, name: v.name, resolvedType: v.resolvedType };
        }),
      });
    }
    } // end if (depth >= 2)

    // Recompute component counts + impact scores (always — reflects Phase 2a + 2b data)
    const updatedComponentCounts = {};
    for (const [varId, compIds] of _componentsByVarId.entries()) {
      updatedComponentCounts[varId] = compIds.size;
    }
    const updatedImpactScores = computeAllImpactScores();

    // Collect any additional remote vars surfaced through library component bindings
    const seenRemoteIds  = new Set(remoteVars.map(v => v.id));
    const seenRemoteColls = new Set(remoteColls.map(c => c.id));
    for (const varId of _componentsByVarId.keys()) {
      if (_localVarIds.has(varId) || seenRemoteIds.has(varId)) continue;
      const v    = _varById.get(varId);
      const coll = v ? _collById.get(v.variableCollectionId) : null;
      if (!v) continue;
      seenRemoteIds.add(varId);
      remoteVars.push({
        id: v.id, libraryKey: v.key || null, name: v.name,
        resolvedType: v.resolvedType, variableCollectionId: v.variableCollectionId,
        hex: v.resolvedType === 'COLOR' ? resolveHex(v.id) : null,
        dependentCount: 0, isRemote: true,
      });
      if (coll && !seenRemoteColls.has(coll.id)) {
        seenRemoteColls.add(coll.id);
        remoteColls.push({ id: coll.id, key: coll.key || null, name: coll.name, modes: coll.modes, isRemote: true });
      }
    }

    // The three sources above (local aliases, library enumeration, canvas bindings)
    // can each surface the SAME library variable under a different per-file id —
    // and, when the file is subscribed to an older publish, a different name. Only
    // the key is stable, so collapse on it.
    remoteVars = dedupeRemoteVarsByKey(remoteVars, liveNameByKey);

    // Rebuild the component browser cache from the FULL index (local + library
    // components discovered in this scan) before it's persisted below. Without
    // this, the cache would keep the init-time local-only list, so every
    // token→library-component association would be lost on the next open until a
    // fresh scan re-discovered them.
    {
      const compToVars = new Map();
      for (const [varId, compIds] of _componentsByVarId.entries()) {
        for (const cid of compIds) {
          if (!compToVars.has(cid)) compToVars.set(cid, new Set());
          compToVars.get(cid).add(varId);
        }
      }
      const rebuilt = [];
      for (const [cid, varIds] of compToVars.entries()) {
        const meta = _componentById.get(cid);
        if (!meta) continue;
        const boundVars = [...varIds].filter(vid => _varById.has(vid)).map(vid => {
          const v = _varById.get(vid);
          return { id: vid, name: v.name, resolvedType: v.resolvedType };
        }).sort((a, b) => a.name.localeCompare(b.name));
        rebuilt.push({
          nodeId: cid, nodeName: meta.name, nodeType: meta.type,
          pageName: meta.pageName, pageId: meta.pageId, isRemote: !!meta.isRemote,
          boundCount: varIds.size, boundVars,
        });
      }
      rebuilt.sort((a, b) =>
        b.boundCount - a.boundCount ||
        (a.pageName || '').localeCompare(b.pageName || '') ||
        a.nodeName.localeCompare(b.nodeName)
      );
      _componentBrowserCache = rebuilt;
    }

    // Persist before posting results — guarantees cache is written even if user closes immediately.
    // Strip zero entries before storing: dense objects with thousands of varIds blow past the
    // 1 MB Figma clientStorage limit. Sparse representation cuts the payload by 10–100×.
    function sparseObj(obj) {
      const out = {};
      for (const k of Object.keys(obj)) { if (obj[k]) out[k] = obj[k]; }
      return out;
    }
    const scanTs = Date.now();
    // Same key derivation as init: content signature when fileKey is unavailable,
    // so the write lands in this file's own slot (and is stamped for verification).
    const [_sigVars, _sigColls] = await Promise.all([
      figma.variables.getLocalVariablesAsync(),
      figma.variables.getLocalVariableCollectionsAsync(),
    ]);
    const _writeSig = fileSigFrom(_sigVars, _sigColls);
    const scanCacheKey = 'scan-' + (figma.fileKey || 'local');
    const cacheBase = {
      version: 2, ts: scanTs, depth, _fileSig: _writeSig,
      instanceCounts:        sparseObj(instObj),
      directCounts:          sparseObj(directObj),
      updatedComponentCounts: sparseObj(updatedComponentCounts),
      updatedImpactScores:    sparseObj(updatedImpactScores),
    };
    async function writeScanCache() {
      try {
        await figma.clientStorage.setAsync(scanCacheKey, Object.assign({}, cacheBase, { newLibraryComponents, remoteVars, remoteColls, browserComponents: _componentBrowserCache || [] }));
        return;
      } catch (e1) {
        figma.ui.postMessage({ type: 'scan-cache-write-failed', attempt: 1, error: String(e1) });
      }
      try {
        await figma.clientStorage.setAsync(scanCacheKey, Object.assign({}, cacheBase, { newLibraryComponents: [], remoteVars, remoteColls }));
        return;
      } catch (e2) {
        figma.ui.postMessage({ type: 'scan-cache-write-failed', attempt: 2, error: String(e2) });
      }
      try {
        await figma.clientStorage.setAsync(scanCacheKey, cacheBase);
        return;
      } catch (e3) {
        figma.ui.postMessage({ type: 'scan-cache-write-failed', attempt: 3, error: String(e3) });
      }
    }
    await Promise.all([
      figma.clientStorage.setAsync('scan-depth', depth).catch(() => {}),
      writeScanCache(),
    ]);

    figma.ui.postMessage({
      type:                  'usage-scan-ready',
      depth,
      instanceCounts:        instObj,
      directCounts:          directObj,
      total:                 scanTotal,
      updatedComponentCounts,
      updatedImpactScores,
      newLibraryComponents,
      remoteVars,
      remoteColls,
      // Fresh local variable list so the UI can drop deleted vars and pick up
      // additions/renames on rescan (not just recompute counts on the stale list).
      variables:             refreshedVarPayload.variables,
      collections:           refreshedVarPayload.collections,
    });
  } catch (err) {
    figma.ui.postMessage({ type: 'usage-scan-error', message: err.message });
  }
}

// ─── Message router ───────────────────────────────────────────────────────────

let _scanCancelled  = false;
let _initCancelled  = false;
let _placeCancelled = false;

figma.ui.onmessage = async (msg) => {
  if (await handleResizeMsg(msg)) return;
  switch (msg.type) {
    case 'init':                  _initCancelled = false; return handleInit(msg && msg.force === true);
    case 'analyze':                       return handleAnalyze(msg.variableId);
    case 'analyze-remote':               return handleAnalyzeRemote(msg.variableId, msg.varName, msg.resolvedType, msg.collectionName);
    case 'build-component-index-remote': return handleBuildComponentIndexRemote(msg.variableId);
    case 'usage-scan':           _scanCancelled = false; return handleUsageScan(msg);
    case 'usage-scan-cancel':    _scanCancelled = true; return;
    case 'get-referenced-by':            return handleGetReferencedBy(msg.variableId);
    case 'focus-node':            return handleFocusNode(msg.nodeId, msg.pageId);
    case 'place-components':     _placeCancelled = false; return handlePlaceComponents(msg);
    case 'place-cancel':         _placeCancelled = true; return;
    case 'close':                 _initCancelled = true; _scanCancelled = true; _placeCancelled = true; return figma.closePlugin();
  }
};
