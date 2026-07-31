import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  scriptSource, functionBodyAt, handledTypes, backendPostedTypes, uiPostedTypes,
  iconRefsAndDefs, elementIdsUsedAndDefined, CORE_HANDLED,
} from '@rms/test-utils';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS = ['impact-atlas', 'tokens-to-ink', 'font-scaling-lab'];

/**
 * No exception list on purpose. `code.js` and `ui.html` always ship together in
 * one zip, so an old backend can never talk to a new UI — there is no version
 * skew for a "legacy message" to protect against. Persisted state (the scan
 * cache) carries its own `version` guard instead. So every branch must earn its
 * place: if the backend doesn't send it, delete it.
 */

/**
 * Static checks over each plugin's UI and backend.
 *
 * These read the source rather than run it, so they catch breakage behaviour
 * tests can't see: a renamed icon leaving a dangling reference, a deleted element
 * still being looked up, or one side of the message contract drifting from the
 * other.
 */
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

function contractOf(plugin) {
  const backend = read(`apps/${plugin}/src/code.js`);
  const ui = scriptSource(read(`apps/${plugin}/ui.src.html`));

  const uiRouter = functionBodyAt(ui, /window\.onmessage\s*=/);
  const beRouter = functionBodyAt(backend, /figma\.ui\.onmessage\s*=/);

  return {
    uiRouterFound: !!uiRouter,
    beRouterFound: !!beRouter,
    uiHandles: handledTypes(uiRouter && uiRouter.text),
    beHandles: [...handledTypes(beRouter && beRouter.text), ...CORE_HANDLED],
    bePosts: backendPostedTypes(backend),
    uiPosts: uiPostedTypes(ui),
  };
}

describe.each(PLUGINS)('%s — UI wiring', (plugin) => {
  it('has a message router on both sides', () => {
    const c = contractOf(plugin);
    expect(c.uiRouterFound).toBe(true);
    expect(c.beRouterFound).toBe(true);
    expect(c.uiHandles.length).toBeGreaterThan(0);
    expect(c.beHandles.length).toBeGreaterThan(0);
  });

  it('never sends the plugin a message it cannot handle', () => {
    // A dropped message is a control that silently does nothing.
    const c = contractOf(plugin);
    expect(c.uiPosts.filter((t) => !c.beHandles.includes(t))).toEqual([]);
  });

  it('does not listen for messages the plugin never sends', () => {
    // A branch for a message that can never arrive reads as a working feature but
    // is unreachable — dead weight that hides real breakage.
    const c = contractOf(plugin);
    expect(c.uiHandles.filter((t) => !c.bePosts.includes(t))).toEqual([]);
  });

  it('only draws icons that exist', () => {
    // Renaming an icon in the shared sprite must not leave a blank square behind.
    const { refs, defs } = iconRefsAndDefs(read(`apps/${plugin}/ui.html`));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !defs.includes(r))).toEqual([]);
  });

  it('only reaches for elements that are in the markup', () => {
    // Guards against renaming or deleting an element and leaving the code behind.
    const { used, defined } = elementIdsUsedAndDefined(read(`apps/${plugin}/ui.html`));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((id) => !defined.includes(id))).toEqual([]);
  });

  it('reports failures as a toast, never as an inline banner', () => {
    // All three plugins used to disagree here: two rendered a red box into a bare
    // #error-container that outlived the problem, one used a toast. The banner is
    // gone — this keeps it from coming back one plugin at a time.
    const ui = read(`apps/${plugin}/ui.src.html`);
    expect(ui).not.toMatch(/error-msg|error-container/);
  });

  it('ships a built UI that matches its source', () => {
    // The built ui.html is what Figma loads; a stale one means testing a ghost.
    const src = read(`apps/${plugin}/ui.src.html`);
    const built = read(`apps/${plugin}/ui.html`);
    expect(/<!--@THEME-->|<!--@UI-->/.test(src)).toBe(true);   // source keeps the markers
    expect(/<!--@THEME-->|<!--@UI-->/.test(built)).toBe(false); // build replaced them
    expect(built.length).toBeGreaterThan(src.length / 2);
  });
});
