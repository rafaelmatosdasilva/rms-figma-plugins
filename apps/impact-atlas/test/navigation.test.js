import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));
const paint = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

function twoPageScene() {
  const token = makeVar('v1', 'button/background');
  const onPage1 = makeComponent('cardComponent', {
    id: 'comp-1', fills: paint, boundVariables: { fills: [{ id: 'v1' }] },
  });
  const onPage2 = makeComponent('buttonPrimary', {
    id: 'comp-2', fills: paint, boundVariables: { fills: [{ id: 'v1' }] },
  });
  return {
    variables: [token],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [makePage('Page 1', [onPage1]), makePage('Page 2', [onPage2])],
  };
}

describe('impact-atlas — focus node', () => {
  it('selects the node and brings it into view', async () => {
    const scene = twoPageScene();
    const { figma, send } = await loadPlugin(ENTRY, scene);
    let zoomed = null;
    figma.viewport.scrollAndZoomIntoView = (nodes) => { zoomed = nodes; };

    await send({ type: 'init' });
    await send({ type: 'focus-node', nodeId: 'comp-1' });

    expect(figma.currentPage.selection.map((n) => n.id)).toEqual(['comp-1']);
    expect(zoomed.map((n) => n.id)).toEqual(['comp-1']);
  });

  it('switches to the page the node lives on', async () => {
    const { figma, send } = await loadPlugin(ENTRY, twoPageScene());

    await send({ type: 'init' });
    await send({ type: 'focus-node', nodeId: 'comp-2' });

    expect(figma.currentPage.name).toBe('Page 2');
    expect(figma.currentPage.selection.map((n) => n.id)).toEqual(['comp-2']);
  });

  it('does nothing when the node is gone instead of throwing', async () => {
    // Library components resolve to nothing in this file — the UI hides focus for
    // them, but the handler must stay safe if one slips through.
    const { figma, send } = await loadPlugin(ENTRY, twoPageScene());

    await send({ type: 'init' });
    await expect(send({ type: 'focus-node', nodeId: 'not-here' })).resolves.not.toThrow();
    expect(figma.currentPage.selection).toEqual([]);
  });
});

describe('impact-atlas — referenced by', () => {
  it('lists the local tokens that alias a remote one', async () => {
    const remote = makeVar('lib-v1', 'library/blue', { remote: true, collectionId: 'lib-coll' });
    const localAlias = makeVar('v-local', 'semantic/accent', { aliasOf: 'lib-v1' });
    const unrelated = makeVar('v-other', 'other/token');

    const { send, lastOf } = await loadPlugin(ENTRY, {
      variables: [localAlias, unrelated],
      collections: [makeCollection('coll-1', 'Local')],
      remoteVars: [remote],
      remoteColls: [makeCollection('lib-coll', 'Library', { remote: true })],
      pages: [makePage('Page 1')],
    });

    await send({ type: 'init' });
    await send({ type: 'get-referenced-by', variableId: 'lib-v1' });

    const msg = lastOf('referenced-by');
    expect(msg).toBeDefined();
    expect(msg.remoteVarId).toBe('lib-v1');
    const names = msg.referencedBy.map((r) => r.name);
    expect(names).toContain('semantic/accent');
    expect(names).not.toContain('other/token');
  });

  it('returns an empty list when nothing references it', async () => {
    const remote = makeVar('lib-v1', 'library/blue', { remote: true, collectionId: 'lib-coll' });
    const { send, lastOf } = await loadPlugin(ENTRY, {
      variables: [makeVar('v-other', 'other/token')],
      collections: [makeCollection('coll-1', 'Local')],
      remoteVars: [remote],
      remoteColls: [makeCollection('lib-coll', 'Library', { remote: true })],
      pages: [makePage('Page 1')],
    });

    await send({ type: 'init' });
    await send({ type: 'get-referenced-by', variableId: 'lib-v1' });

    expect(lastOf('referenced-by').referencedBy).toEqual([]);
  });
});

describe('impact-atlas — close', () => {
  it('loads the target page before resolving the node', async () => {
    // documentAccess is dynamic-page: a node on an unloaded page does not resolve,
    // so focus silently did nothing. The UI sends pageId; the handler must load that
    // page first. (There is no figma.getPageByIdAsync — using it threw and broke
    // every focus button.)
    const scene = twoPageScene();
    const page2 = scene.pages[1];
    const { figma, send } = await loadPlugin(ENTRY, scene);

    const before = page2.loadCount;
    await send({ type: 'focus-node', nodeId: 'comp-2', pageId: page2.id });

    expect(page2.loadCount).toBeGreaterThan(before);
    expect(figma._focused.map((n) => n.id)).toContain('comp-2');
  });

  it('reports when a node cannot be focused instead of doing nothing', async () => {
    // A library master has no canvas location here. Silence read as a broken button,
    // so the backend says so and the UI retags the row to the library badge.
    const { send, lastOf } = await loadPlugin(ENTRY, twoPageScene());

    await send({ type: 'focus-node', nodeId: 'not-here', pageId: null });

    expect(lastOf('focus-unavailable')).toBeDefined();
  });

  it('does not bulk-load pages on init', async () => {
    // A background reachability pass that loaded every page pulled in other files'
    // content and thrashed the caches. Page loading belongs to an explicit scan.
    const scene = twoPageScene();
    const { send } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });

    const loads = scene.pages.reduce((n, p) => n + p.loadCount, 0);
    expect(loads).toBeLessThanOrEqual(scene.pages.length);
  });

  it('closes the plugin', async () => {
    const { figma, send } = await loadPlugin(ENTRY, twoPageScene());
    await send({ type: 'close' });
    expect(figma.closed).toBe(true);
  });
});
