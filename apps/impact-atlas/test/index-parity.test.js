// CALCULATION-PARITY HARNESS — locks the impact/index numbers so the
// `collectComponentBindings` refactor (which threads per-variant bindings for the
// place-affected-variant feature) cannot silently move a single score, count, or
// list entry. The inline snapshots below were filled against the ORIGINAL code.js
// (before the refactor) and must stay byte-identical through it.
//
// The new `variants` field is intentionally STRIPPED before snapshotting, so parity
// is judged only on the fields that existed before the change (score, compUsage,
// boundCount, membership, ordering). Any drift there fails the build.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  loadPlugin, makeVar, makeCollection, makePage, makeComponent, makeComponentSet,
  makeInstance, makeNode,
} from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));
const paint = [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 } }];

const bound = (id) => ({ fills: paint, boundVariables: { fills: [{ id }] } });

// Exercises the LOCAL master scan (site 1) + lookupComponents:
//   - a plain COMPONENT bound to the token
//   - a set bound only on ONE variant child (hover), default unbound
//   - a set bound on TWO variant children (hover + focus)
//   - a set bound at SET LEVEL (componentPropertyDefinitions), no variant child bound
function localScene() {
  const token = makeVar('v1', 'button/background');

  const plain = makeComponent('AAA_plain', { id: 'comp-plain', ...bound('v1') });

  const hoverOnly = makeComponentSet('BBB_hoverOnly', {
    id: 'set-hover',
    children: [
      makeComponent('State=default', { id: 'sh-default', fills: paint }),
      makeComponent('State=hover',   { id: 'sh-hover', ...bound('v1') }),
    ],
  });

  const twoVariants = makeComponentSet('CCC_twoVariants', {
    id: 'set-two',
    children: [
      makeComponent('State=default', { id: 'st-default', fills: paint }),
      makeComponent('State=hover',   { id: 'st-hover', ...bound('v1') }),
      makeComponent('State=focus',   { id: 'st-focus', ...bound('v1') }),
    ],
  });

  const setLevel = makeComponentSet('DDD_setLevel', {
    id: 'set-level',
    componentPropertyDefinitions: { Color: { type: 'VARIANT', boundVariables: { value: { id: 'v1' } } } },
    children: [
      makeComponent('State=default', { id: 'sl-default', fills: paint }),
      makeComponent('State=hover',   { id: 'sl-hover', fills: paint }),
    ],
  });

  return {
    variables: [token],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [makePage('Page 1', [plain, hoverOnly, twoVariants, setLevel])],
  };
}

// Exercises the CANVAS usage scan (site 2b): a local master with an instance, plus a
// loose layer binding the same token directly.
function canvasScene() {
  const token = makeVar('v1', 'button/background');
  const master = makeComponent('buttonPrimary', { id: 'comp-1', ...bound('v1') });
  const instance = makeInstance(master, { id: 'inst-1' });
  const loose = makeNode('RECTANGLE', { id: 'rect-1', name: 'Loose swatch', ...bound('v1') });
  const page = makePage('Page 1', [master, instance, loose]);
  return {
    variables: [token],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [page],
  };
}

// Drop the new `variants` field + volatile bits; keep only pre-refactor fields, sorted
// deterministically, so the snapshot is a pure calculation fingerprint.
function fingerprint(components) {
  return (components || [])
    .map((c) => ({
      nodeId: c.nodeId,
      nodeName: c.nodeName,
      nodeType: c.nodeType,
      pageName: c.pageName,
      boundCount: c.boundCount,
      boundVars: (c.boundVars || []).map((v) => v.id).sort(),
    }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

describe('impact-atlas — calculation parity (locked before the variant refactor)', () => {
  it('local scan + lookupComponents: impact and component list are unchanged', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, localScene());
    await send({ type: 'init' });
    await send({ type: 'analyze', variableId: 'v1' });

    const { impact, components } = lastOf('chain-result');

    // Invariants the user explicitly cares about:
    // every bound component/set counts ONCE (variants are rolled up to the set).
    expect(impact.compUsage).toBe(4);
    expect(components).toHaveLength(4);
    // the hover-only set appears once, its boundCount is the union size (1), not per-variant.
    const hoverEntry = components.find((c) => c.nodeId === 'set-hover');
    expect(hoverEntry.boundCount).toBe(1);

    expect(impact).toMatchInlineSnapshot(`
      {
        "compUsage": 4,
        "depth": 0,
        "multiplier": 0.5,
        "score": 8,
        "tokenType": "primitive",
        "varDeps": 0,
      }
    `);
    expect(fingerprint(components)).toMatchInlineSnapshot(`
      [
        {
          "boundCount": 1,
          "boundVars": [
            "v1",
          ],
          "nodeId": "comp-plain",
          "nodeName": "AAA_plain",
          "nodeType": "COMPONENT",
          "pageName": "Page 1",
        },
        {
          "boundCount": 1,
          "boundVars": [
            "v1",
          ],
          "nodeId": "set-hover",
          "nodeName": "BBB_hoverOnly",
          "nodeType": "COMPONENT_SET",
          "pageName": "Page 1",
        },
        {
          "boundCount": 1,
          "boundVars": [
            "v1",
          ],
          "nodeId": "set-level",
          "nodeName": "DDD_setLevel",
          "nodeType": "COMPONENT_SET",
          "pageName": "Page 1",
        },
        {
          "boundCount": 1,
          "boundVars": [
            "v1",
          ],
          "nodeId": "set-two",
          "nodeName": "CCC_twoVariants",
          "nodeType": "COMPONENT_SET",
          "pageName": "Page 1",
        },
      ]
    `);
  });

  it('canvas usage scan: counts and re-indexed components are unchanged', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, canvasScene());
    await send({ type: 'init' });
    await send({ type: 'usage-scan', depth: 3 });

    const ready = lastOf('usage-scan-ready');
    expect(ready.instanceCounts).toMatchInlineSnapshot(`
      {
        "v1": 1,
      }
    `);
    expect(ready.directCounts).toMatchInlineSnapshot(`
      {
        "v1": 2,
      }
    `);

    // The usage scan also (re)writes _componentsByVarId — verify the impact view it feeds.
    await send({ type: 'analyze', variableId: 'v1' });
    const { impact, components } = lastOf('chain-result');
    expect(impact).toMatchInlineSnapshot(`
      {
        "compUsage": 1,
        "depth": 0,
        "multiplier": 0.5,
        "score": 2,
        "tokenType": "primitive",
        "varDeps": 0,
      }
    `);
    expect(fingerprint(components)).toMatchInlineSnapshot(`
      [
        {
          "boundCount": 1,
          "boundVars": [
            "v1",
          ],
          "nodeId": "comp-1",
          "nodeName": "buttonPrimary",
          "nodeType": "COMPONENT",
          "pageName": "Page 1",
        },
      ]
    `);
  });
});
