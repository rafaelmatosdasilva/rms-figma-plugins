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
const BINDING_TYPES = [
  'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE',
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
  if (!raw || typeof raw !== 'object' || raw.type === 'VARIABLE_ALIAS') return null;
  const { r, g, b } = raw;
  if (r == null || g == null || b == null) return null;
  return rgbToHex(r, g, b);
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

  const base  = (varDeps * 6) + (depth * 2) + (compUsage * 4);
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
    _componentById.set(comp.nodeId, { name: comp.nodeName, type: comp.nodeType, pageName: comp.pageName, pageId: comp.pageId });
    for (const bv of (comp.boundVars || [])) {
      if (!_componentsByVarId.has(bv.id)) _componentsByVarId.set(bv.id, new Set());
      _componentsByVarId.get(bv.id).add(comp.nodeId);
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
      if (c.name.charCodeAt(0) === 46) continue; // skip private "." components
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
      if (c.name.charCodeAt(0) === 46) continue; // skip private "." components

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
    const meta = _componentById.get(cid);
    if (!meta) continue;

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
    scores[id] = Math.round(((varDeps * 6) + (ancDepth * 2) + (compCount * 4)) * mult);
  }
  return scores;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleInit() {
  try {
    // ── Phase 1a: local variables + styles (0% → 20%) ────────────────────────
    // Read persisted scan depth + cached scan in parallel with variable loading
    const _initCacheKey = 'scan-' + (figma.fileKey || 'local');
    const [allVars, allColls, textStyles, paintStyles, effectStyles, lastScanDepth, libColls, _rawCachedScan] = await Promise.all([
      figma.variables.getLocalVariablesAsync(),
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.getLocalTextStylesAsync(),
      figma.getLocalPaintStylesAsync(),
      figma.getLocalEffectStylesAsync(),
      figma.clientStorage.getAsync('scan-depth').catch(() => null),
      figma.teamLibrary && figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync
        ? figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync().catch(() => [])
        : Promise.resolve([]),
      figma.clientStorage.getAsync(_initCacheKey).catch(() => null),
    ]);
    const validCachedScan = (_rawCachedScan && _rawCachedScan.version === 1) ? _rawCachedScan : null;
    // Send progress now that we know whether a cache exists — UI suppresses the bar if hasCachedScan
    figma.ui.postMessage({ type: 'init-progress', pct: 0, hasCachedScan: !!validCachedScan, cachedDepth: validCachedScan ? validCachedScan.depth : null });
    const hasExternalLibraries = Array.isArray(libColls) && libColls.length > 0;

    _collById = new Map(allColls.map(c => [c.id, c]));
    buildAliasMaps(allVars);
    _descendantCounts = buildDescendantCountMap();
    _localVarIds = new Set(_varById.keys());

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
      _populateIndexFromCache(validCachedScan.browserComponents);
      _componentIndexBuilt   = true;
      _componentBrowserCache = validCachedScan.browserComponents;
      figma.ui.postMessage({
        type: 'init-data', variables, collections,
        remoteVars:           validCachedScan.remoteVars  || [],
        remoteColls:          validCachedScan.remoteColls || [],
        componentIndexBuilt:  true,
        varComponentCounts:   validCachedScan.updatedComponentCounts || {},
        varImpactScores:      validCachedScan.updatedImpactScores    || {},
        lastScanDepth:        validCachedScan.depth || null,
        hasExternalLibraries: (validCachedScan.remoteVars || []).length > 0,
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

async function handleBuildComponentIndex(variableId) {
  try {
    if (!_componentIndexBuilt) figma.ui.postMessage({ type: 'index-progress', text: 'Loading pages…' });
    await ensureComponentIndex(); // deduplicates if startup build is still running

    const chain      = await buildChain(variableId);
    const varIds     = [variableId, ...chain.descendants.map(d => d.id)];
    const components = lookupComponents(varIds, variableId);
    const impact     = computeImpact(variableId, chain, components.length);

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

    const varComponentCounts = {};
    for (const [varId, compIds] of _componentsByVarId.entries()) {
      varComponentCounts[varId] = compIds.size;
    }

    const varImpactScores = computeAllImpactScores();

    figma.ui.postMessage({ type: 'index-ready', components, impact, remoteVars, remoteColls, varComponentCounts, varImpactScores });
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

async function handleFocusNode(nodeId) {
  try {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) return;
    let p = node;
    while (p && p.type !== 'PAGE') p = p.parent;
    if (p && p !== figma.currentPage) await figma.setCurrentPageAsync(p);
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
  } catch (_) {}
}

// ─── Message router ───────────────────────────────────────────────────────────

// ─── Component browser ────────────────────────────────────────────────────────
// Returns ALL components (across all pages) sorted by bound variable count.
// Reuses the component index built by buildComponentIndex(); builds it first
// if not already done.

async function handleBuildComponentBrowser() {
  try {
    if (!_componentIndexBuilt) {
      figma.ui.postMessage({ type: 'index-progress', text: 'Loading components…' });
      await buildComponentIndex();
      _componentIndexBuilt = true;
    }

    if (_componentBrowserCache) {
      figma.ui.postMessage({ type: 'component-browser-ready', components: _componentBrowserCache });
      return;
    }

    // Invert _componentsByVarId → compId → Set<varId>
    const compToVars = new Map();
    for (const [varId, compIds] of _componentsByVarId.entries()) {
      for (const cid of compIds) {
        if (!compToVars.has(cid)) compToVars.set(cid, new Set());
        compToVars.get(cid).add(varId);
      }
    }

    const components = [];
    for (const [cid, varIds] of compToVars.entries()) {
      const meta = _componentById.get(cid);
      if (!meta) continue;
      const boundVars = [...varIds].filter(vid => _varById.has(vid)).map(vid => {
        const v = _varById.get(vid);
        return { id: vid, name: v.name, resolvedType: v.resolvedType };
      }).sort((a, b) => a.name.localeCompare(b.name));
      components.push({
        nodeId: cid, nodeName: meta.name, nodeType: meta.type,
        pageName: meta.pageName, pageId: meta.pageId,
        boundCount: varIds.size, boundVars,
      });
    }

    components.sort((a, b) =>
      b.boundCount - a.boundCount ||
      a.pageName.localeCompare(b.pageName) ||
      a.nodeName.localeCompare(b.nodeName)
    );

    _componentBrowserCache = components;

    // Collect every variable referenced by the browser data so the UI can
    // populate its list — buildComponentIndex() may have fetched remote/local
    // vars via getVariableByIdAsync that were never sent to the UI.
    const referencedIds = new Set();
    for (const c of components) for (const bv of c.boundVars) referencedIds.add(bv.id);
    const vars = [];
    for (const vid of referencedIds) {
      const v = _varById.get(vid);
      if (!v) continue;
      const coll = _collById.get(v.variableCollectionId);
      vars.push({
        id: v.id, name: v.name, resolvedType: v.resolvedType,
        variableCollectionId: v.variableCollectionId,
        collectionName: coll ? coll.name : '',
        libraryKey: v.key || null,
        isRemote: !!v.remote,
      });
    }

    figma.ui.postMessage({ type: 'component-browser-ready', components, vars });
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message });
  }
}

async function handleUsageScan(msg) {
  const depth = (msg && msg.depth >= 2) ? msg.depth : 3;
  try {
    // ── Phase 2a: remote / library variable discovery ─────────────────────────
    figma.ui.postMessage({ type: 'usage-scan-progress', pct: 0 });

    let remoteVars = [];
    let remoteColls = [];
    try {
      const [discovered, allLib] = await Promise.all([
        discoverRemoteVarsFromAliases(),
        enumerateAllLibraryVars(),
      ]);
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
    const hasExternalLibraries = remoteVars.length > 0 || remoteColls.length > 0;
    let instObj = {}, directObj = {}, scanTotal = 0, newLibraryComponents = [];
    if (depth >= 2 && hasExternalLibraries) {
    await figma.loadAllPagesAsync();

    const pages = figma.root.children;

    // Count total INSTANCE nodes per page — pages phase = first 15%
    let total = 0;
    for (let pi = 0; pi < pages.length; pi++) {
      figma.ui.postMessage({ type: 'usage-scan-progress', pct: Math.round(((pi + 1) / pages.length) * 15) });
      await yieldTick();
      total += pages[pi].findAllWithCriteria({ types: ['INSTANCE'] }).length;
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

            // Record metadata for Components view. A node is remote when it
            // doesn't belong to the local component index (which only contains
            // current-file masters).
            const isRemote = !_componentById.has(cacheKey);

            // Index library components into the main component index so they
            // show up in impact analysis (deferred from init for performance).
            if (isRemote && varIds.size > 0) {
              _componentById.set(cacheKey, { name: cacheNode.name, type: cacheNode.type, pageName: 'Library', pageId: null, isRemote: true });
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

    // Fetch any external var IDs from library component bindings not yet in _varById
    // Must happen before building newLibraryComponents so boundVars are populated
    const unknownCompIds = [];
    for (const [, info] of compInfo.entries()) {
      if (!info.isRemote) continue;
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
    } // end if (depth >= 3)

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

    // Persist before posting results — guarantees cache is written even if user closes immediately.
    // Strip zero entries before storing: dense objects with thousands of varIds blow past the
    // 1 MB Figma clientStorage limit. Sparse representation cuts the payload by 10–100×.
    function sparseObj(obj) {
      const out = {};
      for (const k of Object.keys(obj)) { if (obj[k]) out[k] = obj[k]; }
      return out;
    }
    const scanTs = Date.now();
    const scanCacheKey = 'scan-' + (figma.fileKey || 'local');
    const cacheBase = {
      version: 1, ts: scanTs, depth,
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
    });
  } catch (err) {
    figma.ui.postMessage({ type: 'usage-scan-error', message: err.message });
  }
}

let _scanCancelled = false;
let _initCancelled = false;

figma.ui.onmessage = async (msg) => {
  if (await handleResizeMsg(msg)) return;
  switch (msg.type) {
    case 'init':                  _initCancelled = false; return handleInit();
    case 'analyze':                       return handleAnalyze(msg.variableId);
    case 'analyze-remote':               return handleAnalyzeRemote(msg.variableId, msg.varName, msg.resolvedType, msg.collectionName);
    case 'build-component-index-remote': return handleBuildComponentIndexRemote(msg.variableId);
    case 'usage-scan':           _scanCancelled = false; return handleUsageScan(msg);
    case 'usage-scan-cancel':    _scanCancelled = true; return;
    case 'get-referenced-by':            return handleGetReferencedBy(msg.variableId);
    case 'focus-node':            return handleFocusNode(msg.nodeId);
    case 'close':                 _initCancelled = true; _scanCancelled = true; return figma.closePlugin();
  }
};
