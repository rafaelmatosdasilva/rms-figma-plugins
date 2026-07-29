import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent, makeGate,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));
const paint = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

/** A local token aliasing a library token, with a component bound to the local one. */
function remoteScene() {
  const remote = makeVar('lib-v1', 'library/blue', { remote: true, collectionId: 'lib-coll' });
  const local = makeVar('v-local', 'semantic/accent', { aliasOf: 'lib-v1' });
  const comp = makeComponent('buttonPrimary', {
    id: 'comp-1', fills: paint, boundVariables: { fills: [{ id: 'v-local' }] },
  });
  const page = makePage('Page 1');
  page.appendChild(comp);

  return {
    variables: [local],
    collections: [makeCollection('coll-1', 'Local')],
    remoteVars: [remote],
    remoteColls: [makeCollection('lib-coll', 'Library', { remote: true })],
    pages: [page],
  };
}

describe('impact-atlas — analysing a library token', () => {
  it('returns a chain for a token that lives in another file', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, remoteScene());
    await send({ type: 'init' });
    await send({
      type: 'analyze-remote', variableId: 'lib-v1',
      varName: 'library/blue', resolvedType: 'COLOR', collectionName: 'Library',
    });

    const { chain } = lastOf('chain-result');
    expect(chain.selectedId).toBe('lib-v1');
    expect(chain.self.name).toBe('library/blue');
    // The local token that aliases it shows up as a descendant.
    expect(chain.descendants.map((d) => d.name)).toContain('semantic/accent');
  });

  it('names the token from the message when the file has never resolved it', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, {
      variables: [], collections: [makeCollection('coll-1', 'Local')], pages: [makePage('Page 1')],
    });
    await send({ type: 'init' });
    await send({
      type: 'analyze-remote', variableId: 'lib-unknown',
      varName: 'library/unknown', resolvedType: 'FLOAT', collectionName: 'Library',
    });

    expect(lastOf('chain-result').chain.self).toMatchObject({
      name: 'library/unknown', resolvedType: 'FLOAT', isExternal: true,
    });
  });

  it('lists the components a library token reaches through local aliases', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, remoteScene());
    await send({ type: 'init' });
    await send({ type: 'build-component-index-remote', variableId: 'lib-v1' });

    const ready = lastOf('index-ready');
    expect(ready).toBeDefined();
    expect(ready.components.map((c) => c.nodeName)).toContain('buttonPrimary');
  });
});

describe('impact-atlas — place cancellation', () => {
  it('abandons the board and reports the cancel', async () => {
    const scene = remoteScene();
    const { figma, send, postedOf } = await loadPlugin(ENTRY, scene);
    await send({ type: 'init' });

    // Suspend the component lookup so the cancel lands while the board is half-built.
    const gate = makeGate();
    const realGetNode = figma.getNodeByIdAsync;
    figma.getNodeByIdAsync = async (id) => { await gate.promise; return realGetNode(id); };

    const inFlight = send({
      type: 'place-components', title: 'semantic/accent', date: '2026-07-25 10:00',
      components: [{ nodeId: 'comp-1', name: 'buttonPrimary' }],
    });
    await send({ type: 'place-cancel' });
    gate.open();
    await inFlight;

    expect(postedOf('place-cancelled').length).toBeGreaterThan(0);
    expect(postedOf('place-done')).toEqual([]);

    // No half-finished Section is left behind on the previews page.
    const sections = (figma._created?.sections || []).filter((s) => !s.removed);
    expect(sections).toEqual([]);
  });
});
