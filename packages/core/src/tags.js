// ─── Description tag helpers ─────────────────────────────────────────────────
// Tags are stored in a Figma variable description as: [tag:value]
// Multiple tags coexist with any other description text.

/**
 * Returns the value of [tag:…] in desc, or null if absent.
 */
export function parseDescTag(desc, tag) {
  if (!desc) return null;
  const m = desc.match(new RegExp(`\\[${tag}:([^\\]]+)\\]`, "i"));
  return m ? m[1].trim() : null;
}

/**
 * Upserts [tag:value] inside desc, preserving all other text and tags.
 */
export function setDescTag(desc, tag, value) {
  const base = desc || "";
  const newTag = `[${tag}:${value}]`;
  const replaced = base.replace(new RegExp(`\\[${tag}:[^\\]]*\\]`, "gi"), newTag);
  if (replaced !== base) return replaced;
  const t = base.trim();
  return t ? `${t} ${newTag}` : newTag;
}

/**
 * Removes [tag:…] from desc.
 */
export function removeDescTag(desc, tag) {
  if (!desc) return "";
  return desc.replace(new RegExp(`\\s*\\[${tag}:[^\\]]*\\]`, "gi"), "").trim();
}
