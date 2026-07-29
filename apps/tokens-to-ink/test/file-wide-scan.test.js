import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeNode, waitFor,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

/**
 * Nothing selected, and the file's colours come from two places: one local
 * variable, and one published by a subscribed library. Both belong in the list —
 * a print workflow is usually pairing library brand colours.
 */
function scene() {
  const local = makeVar('v-local', 'local/ink', { value: { r: 0, g: 0, b: 0 } });
  const libVar = makeVar('v-lib', 'brand/primary', {
    value: { r: 1, g: 0, b: 0 }, key: 'lib-key-1', collectionId: 'coll-lib', remote: true,
  });

  const page = makePage('Page 1', [makeNode('FRAME', { name: 'Artwork', fills: [] })]);
  page.selection = [];

  return {
    scene: {
      variables: [local],
      collections: [makeCollection('coll-1', 'Tokens')],
      remoteVars: [libVar],
      remoteColls: [makeCollection('coll-lib', 'Brand', { key: 'ckey-brand', remote: true })],
      libraryCollections: [{ key: 'ckey-brand', libraryName: 'Brand Library' }],
      libraryVariables: { 'ckey-brand': [{ key: 'lib-key-1', name: 'brand/primary', resolvedType: 'COLOR' }] },
      pages: [page],
    },
    page,
  };
}

/** The document-change rescan is debounced by 400 ms. */
const DEBOUNCE_GRACE = 700;

/** The plugin scans on launch; wait that out before driving it by hand. */
async function scanOnce({ send, lastOf, postedOf }) {
  await waitFor(() => lastOf('scan-results'), { label: 'launch scan' });
  const before = postedOf('scan-results').length;
  await send({ type: 'request-scan' });
  await waitFor(() => postedOf('scan-results').length > before, { label: 'requested scan' });
  return lastOf('scan-results');
}

describe('tokens-to-ink — file-wide colour list', () => {
  it('includes colours published by a subscribed library, not just local ones', async () => {
    const { scene: s, page } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    const results = await scanOnce({ send, lastOf, postedOf });

    expect(results.data.map((d) => d.name).sort()).toEqual(['brand/primary', 'local/ink']);
    expect(results.data.find((d) => d.name === 'brand/primary').isExternal).toBe(true);
  });

  it('names the library each external colour came from', async () => {
    const { scene: s, page } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await scanOnce({ send, lastOf, postedOf });
    const resolved = await waitFor(() => lastOf('external-vars-resolved'), { label: 'library names' });

    expect(resolved.libraries['v-lib']).toBe('Brand Library');
  });

  it('resolves library names without refetching every variable it just read', async () => {
    // The collection id rides along on each result, so a file-wide list costs one
    // lookup per collection rather than one per colour.
    const { scene: s, page } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    let byIdCalls = 0;
    const realGet = figma.variables.getVariableByIdAsync;
    figma.variables.getVariableByIdAsync = async (id) => { byIdCalls++; return realGet(id); };

    await scanOnce({ send, lastOf, postedOf });
    await waitFor(() => lastOf('external-vars-resolved'), { label: 'library names' });

    expect(byIdCalls).toBe(0);
  });

  it('reuses the imported library colours when the document changes', async () => {
    // Importing is a round trip per variable. An edit anywhere in the file must
    // not pay that again, or every keystroke re-fetches the whole library.
    const { scene: s, page } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await scanOnce({ send, lastOf, postedOf });
    const importsAfterScan = figma._importedVarKeys.length;
    expect(importsAfterScan).toBeGreaterThan(0);

    const before = postedOf('scan-results').length;
    figma.emit('documentchange');
    await waitFor(() => postedOf('scan-results').length > before, {
      timeout: DEBOUNCE_GRACE, label: 'auto rescan',
    });

    expect(figma._importedVarKeys.length).toBe(importsAfterScan);
    // ...and the library colour is still in the refreshed list.
    expect(lastOf('scan-results').data.map((d) => d.name)).toContain('brand/primary');
  });

  it('goes back to the library when the user asks for a fresh scan', async () => {
    const { scene: s, page } = scene();
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    await scanOnce({ send, lastOf, postedOf });
    const first = figma._importedVarKeys.length;

    await scanOnce({ send, lastOf, postedOf });
    expect(figma._importedVarKeys.length).toBeGreaterThan(first);
  });

  it('still lists local colours when the file has no library access', async () => {
    const { scene: s, page } = scene();
    delete s.libraryCollections; // no teamLibrary at all, as in an unshared file
    const { figma, send, lastOf, postedOf } = await loadPlugin(ENTRY, s);
    figma.currentPage = page;

    const results = await scanOnce({ send, lastOf, postedOf });
    expect(results.data.map((d) => d.name)).toEqual(['local/ink']);
  });
});
