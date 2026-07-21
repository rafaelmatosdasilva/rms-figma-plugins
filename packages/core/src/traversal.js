// ─── Node traversal utilities ────────────────────────────────────────────────
// Operates on Figma node objects (property access only — no figma.* API calls).
// isCancelled: () => boolean — checked before each child to allow cooperative cancellation.

import { rgbToHex } from './colors.js';

/** Yield to the event loop so cancel messages can be delivered between batches. */
export function yieldTick() {
  return new Promise((r) => setTimeout(r, 0));
}

/** How many nodes to process between yields. */
export const YIELD_EVERY = 200;

/**
 * Returns the bound variable ID for a paint at a given index, or null.
 */
export function getPaintVariableId(node, paintType, paintIndex, paint) {
  try {
    if (node.boundVariables && node.boundVariables[paintType]) {
      const binding = node.boundVariables[paintType][paintIndex];
      if (binding && binding.type === "VARIABLE_ALIAS" && binding.id) return binding.id;
    }
  } catch (_) {}
  if (paint.boundVariables && paint.boundVariables.color) return paint.boundVariables.color.id;
  return null;
}

/**
 * Adds a colour entry (variable or raw) into colorMap.
 */
export function addColorEntry(colorMap, varId, fill, nodeId) {
  if (varId) {
    if (!colorMap.has(varId)) colorMap.set(varId, { varId, source: "variable" });
    return;
  }
  if (fill.color) {
    const { r, g, b } = fill.color;
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      const hex = rgbToHex(r, g, b);
      if (!colorMap.has(hex)) colorMap.set(hex, { varId: null, hex, source: "raw", nodeIds: [] });
      if (nodeId) colorMap.get(hex).nodeIds.push(nodeId);
    }
  }
}

/**
 * Recursively collects all solid fill/stroke colours from a node tree into colorMap.
 * @param {isCancelled} () => boolean
 */
export async function collectNodeColors(node, colorMap, isCancelled, _counter = { n: 0 }) {
  if (node.visible === false) return;
  if (typeof node.opacity === "number" && node.opacity === 0) return;

  if ("fills" in node && Array.isArray(node.fills)) {
    for (let i = 0; i < node.fills.length; i++) {
      const fill = node.fills[i];
      if (fill.type === "SOLID" && fill.visible !== false && (fill.opacity == null || fill.opacity > 0)) {
        addColorEntry(colorMap, getPaintVariableId(node, "fills", i, fill), fill, node.id);
      }
    }
  }

  if ("strokes" in node && Array.isArray(node.strokes)) {
    for (let i = 0; i < node.strokes.length; i++) {
      const stroke = node.strokes[i];
      if (stroke.type === "SOLID" && stroke.visible !== false && (stroke.opacity == null || stroke.opacity > 0)) {
        addColorEntry(colorMap, getPaintVariableId(node, "strokes", i, stroke), stroke, node.id);
      }
    }
  }

  if ("children" in node) {
    for (const child of node.children) {
      if (isCancelled()) return;
      if (++_counter.n % YIELD_EVERY === 0) await yieldTick();
      await collectNodeColors(child, colorMap, isCancelled, _counter);
    }
  }
}

/**
 * Recursively collects all bound variable IDs from a node tree into ids (Set).
 * @param {isCancelled} () => boolean
 */
export async function collectVarIds(node, ids, isCancelled, _counter = { n: 0 }) {
  if (node.visible === false) return;
  try {
    const bv = node.boundVariables;
    if (bv) {
      for (const key of Object.keys(bv)) {
        const val = bv[key];
        if (Array.isArray(val)) {
          for (const item of val) { if (item && item.id) ids.add(item.id); }
        } else if (val && val.id) {
          ids.add(val.id);
        }
      }
    }
  } catch (_) {}

  if ("children" in node) {
    for (const child of node.children) {
      if (isCancelled()) return;
      if (++_counter.n % YIELD_EVERY === 0) await yieldTick();
      await collectVarIds(child, ids, isCancelled, _counter);
    }
  }
}
