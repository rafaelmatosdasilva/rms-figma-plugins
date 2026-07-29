import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));
const paint = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];

function sceneWithComponents(n = 3) {
  const token = makeVar('v1', 'button/background/color');
  const comps = [];
  for (let i = 1; i <= n; i++) {
    const c = makeComponent(`component${i}`, {
      id: `comp-${i}`,
      key: `key-${i}`,
      fills: paint,
      boundVariables: { fills: [{ id: 'v1' }] },
      width: 120,
      height: 40,
    });
    // Instancing a master returns a node of the same size, as Figma does.
    c.createInstance = () => makeComponent(`${c.name} instance`, {
      type: 'INSTANCE', width: c.width, height: c.height,
    });
    comps.push(c);
  }
  return {
    scene: {
      variables: [token],
      collections: [makeCollection('coll-1', 'Tokens')],
      pages: [makePage('Page 1', comps)],
    },
    payload: comps.map((c) => ({ nodeId: c.id, name: c.name })),
  };
}

describe('impact-atlas — place components', () => {
  it('places every component and reports how many landed', async () => {
    const { scene, payload } = sceneWithComponents(3);
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });
    await send({
      type: 'place-components',
      title: 'button/background/color',
      date: '2026-07-26 10:00',
      components: payload,
    });

    const done = lastOf('place-done');
    expect(done).toBeDefined();
    expect(done.placed).toBe(3);
    expect(done.skipped).toBe(0);
    expect(done.pageName).toBe('Impact Atlas Previews');
  });

  it('builds one transparent Section titled with the token and timestamp', async () => {
    const { scene, payload } = sceneWithComponents(3);
    const { figma, send } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });
    await send({
      type: 'place-components',
      title: 'button/background/color',
      date: '2026-07-26 10:00',
      components: payload,
    });

    // Exactly one Section, holding the instances — not a frame per component.
    expect(figma._created.sections).toHaveLength(1);
    const section = figma._created.sections[0];
    expect(section.name).toContain('button/background/color');
    expect(section.name).toContain('2026-07-26 10:00');

    // No colour is ever added to the user's document.
    expect(section.fills).toEqual([]);
    for (const frame of figma._created.frames) expect(frame.fills).toEqual([]);

    // The instances live inside the section (via its auto-layout frame).
    const instances = section.findAllWithCriteria({ types: ['INSTANCE'] });
    expect(instances).toHaveLength(3);
  });

  it('reports progress for every component, with an ETA once it can estimate', async () => {
    const { scene, payload } = sceneWithComponents(3);
    const { send, postedOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });
    await send({ type: 'place-components', title: 't', date: 'd', components: payload });

    const progress = postedOf('place-progress');
    // One update per component — a coarser cadence reads as a stuck bar.
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3]);
    expect(progress.every((p) => p.total === 3)).toBe(true);
    // ETA only appears once there's enough data, and never on the last tick.
    expect(progress[0].eta).toBe('');
  });

  it('refuses to place when there is nothing to place', async () => {
    const { scene } = sceneWithComponents(1);
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });
    await send({ type: 'place-components', title: 't', date: 'd', components: [] });

    expect(lastOf('place-error')).toBeDefined();
    expect(lastOf('place-done')).toBeUndefined();
  });

  it('skips components that cannot be instanced rather than failing the run', async () => {
    const { scene, payload } = sceneWithComponents(2);
    const { send, lastOf } = await loadPlugin(ENTRY, scene);

    await send({ type: 'init' });
    await send({
      type: 'place-components',
      title: 't',
      date: 'd',
      components: [...payload, { nodeId: 'does-not-exist', name: 'ghost' }],
    });

    const done = lastOf('place-done');
    expect(done.placed).toBe(2);
    expect(done.skipped).toBe(1);
  });
});
