// ─── Canvas focus ────────────────────────────────────────────────────────────
// Select a node on the Figma canvas and zoom to it. documentAccess:"dynamic-page"
// safe: pass the node's pageId (when the UI knows it) so the page is loaded before
// the lookup — getNodeByIdAsync returns null for a node on a page that isn't loaded,
// which otherwise makes a valid local node look unreachable.

/** The PAGE ancestor of a node, or null. */
export function getPageForNode(node) {
  let p = node;
  while (p && p.type !== "PAGE") p = p.parent;
  return p && p.type === "PAGE" ? p : null;
}

/**
 * Focus one node. Returns { ok } on success, { ok:false, notFound:true } when the
 * node can't be resolved, or { ok:false, error } when something threw. The caller
 * decides how to report failure, so each plugin keeps its own UX (a toast, or a
 * 'focus-unavailable' message).
 */
export async function focusNode(figma, nodeId, pageId) {
  try {
    if (pageId) {
      // A page is a node — getNodeByIdAsync, not getPageByIdAsync (which doesn't exist).
      const page = await figma.getNodeByIdAsync(pageId);
      if (page && page.type === "PAGE") await page.loadAsync();
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) return { ok: false, notFound: true };
    const page = getPageForNode(node);
    if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
