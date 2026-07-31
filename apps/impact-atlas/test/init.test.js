import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPlugin, makeVar, makeCollection, makePage, makeComponent } from '@rms/test-utils';

const ENTRY = fileURLToPath(new URL('../src/code.js', import.meta.url));

// A minimal synthetic file: one collection, a primitive token, an alias that points at
// it, and a local component master bound to the alias.
function scene() {
  const primitive = makeVar('v-primitive', 'primitives/Neutral 300');
  const alias = makeVar('v-alias', 'button/background/color', { aliasOf: 'v-primitive' });
  // A fills binding only counts when there's a paint to bind — same as in Figma.
  const button = makeComponent('buttonPrimary', {
    id: 'comp-button',
    key: 'pub-button',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    boundVariables: { fills: [{ id: 'v-alias' }] },
  });
  return {
    variables: [primitive, alias],
    collections: [makeCollection('coll-1', 'Tokens')],
    pages: [makePage('Page 1', [button])],
  };
}

describe('impact-atlas — init', () => {
  it('reports local variables and the components bound to them', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, scene());

    await send({ type: 'init' });

    const data = lastOf('init-data');
    expect(data).toBeDefined();

    // Both local tokens are listed.
    expect(data.variables.map((v) => v.name).sort()).toEqual([
      'button/background/color',
      'primitives/Neutral 300',
    ]);

    // The component that binds the alias is indexed, with its bound token resolved.
    const button = data.browserComponents.find((c) => c.nodeName === 'buttonPrimary');
    expect(button).toBeDefined();
    expect(button.boundVars.map((b) => b.name)).toContain('button/background/color');

    // A local master must carry its page (that's what makes canvas focus possible)
    // and must not be mistaken for a library component.
    expect(button.pageName).toBe('Page 1');
    expect(button.isRemote).not.toBe(true);
  });

  it('counts a token as affecting the components bound to it', async () => {
    const { send, lastOf } = await loadPlugin(ENTRY, scene());

    await send({ type: 'init' });

    const data = lastOf('init-data');
    expect(data.varComponentCounts['v-alias']).toBe(1);
  });

  it('indexes components whose name starts with a dot', async () => {
    // The master walks skipped "private" dot components while the instance walk did
    // not, so they showed as affected components but were never searchable.
    const token = makeVar('v-dot', 'dot/token');
    const hidden = makeComponent('.dropDownRowBackground', {
      id: 'comp-dot',
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
      boundVariables: { fills: [{ id: 'v-dot' }] },
    });
    const { send, lastOf } = await loadPlugin(ENTRY, {
      variables: [token],
      collections: [makeCollection('c1', 'Tokens')],
      pages: [makePage('Page 1', [hidden])],
    });

    await send({ type: 'init' });

    const names = (lastOf('init-data').browserComponents || []).map((c) => c.nodeName);
    expect(names).toContain('.dropDownRowBackground');
  });
});
