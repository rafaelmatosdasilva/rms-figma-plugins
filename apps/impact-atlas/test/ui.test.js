import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadUI } from '@rms/test-utils';

const UI = fileURLToPath(new URL('../ui.html', import.meta.url));

let ui;
afterEach(() => { if (ui) { ui.close(); ui = null; } });

const collection = { id: 'coll-1', name: 'Tokens', modes: [{ modeId: 'm1', name: 'Mode 1' }] };

const token = (id, name, extra = {}) => ({
  id, name, resolvedType: 'COLOR', variableCollectionId: 'coll-1',
  hex: '#3B82F6', dependentCount: 0, hasExternalAlias: false, ...extra,
});

/**
 * What the plugin sends after scanning the file. Scores drive which tier heading a
 * token lands under, so they're set explicitly rather than left to chance.
 */
function initData(over = {}) {
  return {
    type: 'init-data',
    variables: [
      token('v-high', 'button/background'),
      token('v-low', 'card/border'),
      token('v-none', 'unused/token'),
    ],
    collections: [collection],
    remoteVars: [], remoteColls: [],
    componentIndexBuilt: true,
    varComponentCounts: { 'v-high': 30, 'v-low': 2 }, // 30*4=120 → High, 2*4=8 → Low
    varImpactScores: {},
    lastScanDepth: 1,
    hasExternalLibraries: false,
    browserComponents: [{
      nodeId: 'comp-1', nodeName: 'buttonPrimary', nodeType: 'COMPONENT',
      pageName: 'Page 1', pageId: 'page-1', boundCount: 1,
      boundVars: [{ id: 'v-high', name: 'button/background', resolvedType: 'COLOR' }],
    }],
    cachedScan: null,
    ...over,
  };
}

const chainNode = (id, name) => ({
  id, name, resolvedType: 'COLOR', collectionName: 'Tokens', depth: 1,
  hex: '#3B82F6', isCyclic: false, isExternal: false, aliasModes: [], totalModes: 1, hasChildren: false,
});

function chainResult() {
  return {
    type: 'chain-result',
    chain: {
      selectedId: 'v-high',
      ancestors: [],
      self: chainNode('v-high', 'button/background'),
      descendants: [chainNode('v-alias', 'semantic/accent')],
      blastRadius: { totalDescendants: 1 },
    },
    styles: [],
    components: [{
      nodeId: 'comp-1', nodeName: 'buttonPrimary', nodeType: 'COMPONENT',
      pageName: 'Page 1', pageId: 'page-1', boundCount: 1,
      boundVars: [{ id: 'v-high', name: 'button/background', resolvedType: 'COLOR', hex: '#3B82F6', isSelected: true, via: [] }],
    }],
    impact: { score: 120, tokenType: 'primitive', multiplier: 0.5, varDeps: 0, depth: 0, compUsage: 30 },
  };
}

describe('impact-atlas UI — boot', () => {
  it('asks the plugin for its data as soon as it opens', () => {
    ui = loadUI(UI);
    expect(ui.sentOf('init').length).toBeGreaterThan(0);
  });

  it('starts on the Tokens tab', () => {
    ui = loadUI(UI);
    expect(ui.$('#btn-mode-tokens').className).toContain('selected');
  });

  it('shows a placeholder until something is selected', () => {
    ui = loadUI(UI);
    expect(ui.$('#right-placeholder').className).not.toContain('hidden');
  });
});

describe('impact-atlas UI — token list', () => {
  it('lists the tokens the plugin reported', () => {
    ui = loadUI(UI);
    ui.receive(initData());

    const names = ui.$$('#var-list .var-item .var-name').map((el) => el.textContent);
    expect(names).toContain('button/background');
    expect(names).toContain('card/border');
    expect(names).toContain('unused/token');
  });

  it('groups tokens under their impact tier', () => {
    ui = loadUI(UI);
    ui.receive(initData());

    const headings = ui.$$('#var-list .dividerSection').map((el) => el.textContent);
    expect(headings.join(' ')).toContain('High');
    expect(headings.join(' ')).toContain('Low');
    expect(headings.join(' ')).toContain('Unused');
  });

  it('counts how many tokens sit in each tier', () => {
    ui = loadUI(UI);
    ui.receive(initData());

    const high = ui.$$('#var-list .dividerSection').find((d) => d.textContent.includes('High'));
    expect(high.querySelector('.count').textContent).toBe('1');
  });

  it('asks the plugin to analyse a token when it is clicked', () => {
    ui = loadUI(UI);
    ui.receive(initData());

    const row = ui.$$('#var-list .var-item').find((el) => el.textContent.includes('button/background'));
    ui.click(row);

    expect(ui.sentOf('analyze').map((m) => m.variableId)).toContain('v-high');
  });

  it('narrows the list as you search', async () => {
    ui = loadUI(UI);
    ui.receive(initData());

    const search = ui.$('#search-input');
    search.value = 'card';
    search.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    // Typing is debounced so the list doesn't thrash on every keystroke.
    await new Promise((r) => setTimeout(r, 200));

    const names = ui.$$('#var-list .var-item .var-name').map((el) => el.textContent);
    expect(names).toEqual(['card/border']);
  });
});

describe('impact-atlas UI — token detail', () => {
  /** Select a token the way a user does, then let the plugin answer. */
  function selectToken(name = 'button/background') {
    const row = ui.$$('#var-list .var-item').find((el) => el.textContent.includes(name));
    ui.click(row);
    ui.receive(chainResult());
  }

  it('names the token and its tier in the header', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    selectToken();

    expect(ui.text('#sb-name')).toBe('button/background');
    expect(ui.text('#sb-impact')).toBe('High');
  });

  it('shows the alias tokens and the affected components', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    ui.receive(chainResult());

    expect(ui.$('#gcol-2').textContent).toContain('semantic/accent');
    expect(ui.$('#gcol-3').textContent).toContain('buttonPrimary');
  });

  it('counts the affected components on their heading', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    ui.receive(chainResult());

    expect(ui.$('#gcol-3-lbl-wrap').textContent).toContain('Affected components');
    expect(ui.text('#gcol-3-count')).toBe('1');
  });

  it('offers to place the affected components on canvas', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    ui.receive(chainResult());

    // The action lives on the "Affected components" divider, not the status bar.
    expect(ui.$('#gcol-3-lbl-wrap .place-action-btn')).toBeTruthy();
    expect(ui.$('#sb-main-row .place-action-btn')).toBeNull();
  });

  it('asks the plugin to place them when that is clicked', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    ui.receive(chainResult());
    ui.click('#gcol-3-lbl-wrap .place-action-btn');

    const [msg] = ui.sentOf('place-components');
    expect(msg).toBeTruthy();
    expect(msg.title).toBe('button/background');
    expect(msg.components.map((c) => c.nodeId)).toEqual(['comp-1']);
    // The layer name is stamped with a timestamp, not just a date.
    expect(msg.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('confirms once the components have landed', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    ui.receive(chainResult());
    ui.receive({ type: 'place-done', placed: 3, skipped: 0, truncated: 0, pageName: 'Impact Atlas Previews' });

    expect(ui.document.body.textContent).toContain('Impact Atlas Previews');
  });
});

describe('impact-atlas UI — components tab', () => {
  it('lists the components the plugin found', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    ui.click('#btn-mode-comps');

    expect(ui.$('#comp-list').textContent).toContain('buttonPrimary');
  });

  it('marks a library component as one it cannot focus', () => {
    ui = loadUI(UI);
    ui.receive(initData({
      browserComponents: [{
        nodeId: 'lib-1', nodeName: 'libraryButton', nodeType: 'COMPONENT',
        pageName: 'Library', pageId: null, isRemote: true, boundCount: 1,
        boundVars: [{ id: 'v-high', name: 'button/background', resolvedType: 'COLOR' }],
      }],
    }));
    // Library components only surface once an Extended scan has found them.
    ui.receive({
      type: 'usage-scan-ready', depth: 2, instanceCounts: {}, directCounts: {}, total: 0,
      updatedComponentCounts: {}, updatedImpactScores: {},
      newLibraryComponents: [], remoteVars: [], remoteColls: [],
    });
    ui.click('#btn-mode-comps');

    // No canvas focus for a master that lives in another file — a library mark instead.
    const row = ui.$$('#comp-list .comp-item').find((el) => el.textContent.includes('libraryButton'));
    expect(row.querySelector('.lib-badge')).toBeTruthy();
    expect(row.querySelector('.comp-item-focus-btn')).toBeNull();
  });
});

/**
 * A search is the working set: it survives selecting a result, so you can click
 * through several matches without retyping. It only clears when you drill out of
 * the detail panel, because the token or component you land on may sit outside
 * the query — and the drill selects its target by querying the rendered list.
 */
describe('impact-atlas UI — what a search survives', () => {
  /** Type into the search box and let the debounce settle. */
  async function search(q) {
    const input = ui.$('#search-input');
    input.value = q;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return input;
  }

  /** Two components so a query genuinely narrows the list. */
  const twoComponents = initData({
    browserComponents: [
      {
        nodeId: 'comp-1', nodeName: 'buttonPrimary', nodeType: 'COMPONENT',
        pageName: 'Page 1', pageId: 'page-1', boundCount: 1,
        boundVars: [{ id: 'v-high', name: 'button/background', resolvedType: 'COLOR' }],
      },
      {
        nodeId: 'comp-2', nodeName: 'cardShell', nodeType: 'COMPONENT',
        pageName: 'Page 1', pageId: 'page-1', boundCount: 1,
        boundVars: [{ id: 'v-low', name: 'card/border', resolvedType: 'COLOR' }],
      },
    ],
  });

  it('keeps the query when a component result is selected', async () => {
    ui = loadUI(UI);
    ui.receive(twoComponents);
    ui.click('#btn-mode-comps');
    await search('buttonPrimary');

    const row = ui.$$('#comp-list .comp-item').find((el) => el.textContent.includes('buttonPrimary'));
    ui.click(row);

    expect(ui.$('#search-input').value).toBe('buttonPrimary');
    expect(row.className).toContain('node-selected');
    // Still filtered — the other component has not come back.
    expect(ui.$('#comp-list').textContent).not.toContain('cardShell');
  });

  it('keeps the query when a token result is selected', async () => {
    ui = loadUI(UI);
    ui.receive(initData());
    await search('card');

    const row = ui.$$('#var-list .var-item').find((el) => el.textContent.includes('card/border'));
    ui.click(row);

    expect(ui.$('#search-input').value).toBe('card');
    expect(row.className).toContain('node-selected');
  });

  it('clears the query when drilling from a component into a bound token', async () => {
    ui = loadUI(UI);
    ui.receive(twoComponents);
    ui.click('#btn-mode-comps');
    await search('buttonPrimary');
    ui.click(ui.$$('#comp-list .comp-item').find((el) => el.textContent.includes('buttonPrimary')));

    // "button/background" does not match "buttonPrimary", so it could not be
    // selected in the list unless the query is dropped first.
    ui.click(ui.$('#gcol-2 .node-drill-btn[data-drill-id="v-high"]'));

    expect(ui.$('#search-input').value).toBe('');
    const selected = ui.$('#var-list .var-item.node-selected');
    expect(selected.textContent).toContain('button/background');
  });

  it('clears the query when drilling from a token into an affected component', async () => {
    ui = loadUI(UI);
    ui.receive(twoComponents);
    // "background" matches the token but not the component it will drill to.
    await search('background');
    ui.click(ui.$$('#var-list .var-item').find((el) => el.textContent.includes('button/background')));
    ui.receive(chainResult());

    ui.click(ui.$('#gcol-3 .node-goto-btn[data-goto-node-id="comp-1"]'));

    expect(ui.$('#search-input').value).toBe('');
    const selected = ui.$('#comp-list .comp-item.node-selected');
    expect(selected.textContent).toContain('buttonPrimary');
  });
});

/**
 * The connector lines from the selected row to the graph. jsdom has no layout, so
 * every rect is 0x0 and the drawing code bails on its own zero-rect guard — give
 * elements a plausible box so the geometry actually runs.
 */
function stubGeometry(u) {
  let n = 0;
  u.window.Element.prototype.getBoundingClientRect = function () {
    const y = (n = (n + 37) % 600);
    return { x: 10, y, top: y, left: 10, right: 210, bottom: y + 40, width: 200, height: 40, toJSON() {} };
  };
}

const remoteToken = {
  id: 'r-1', libraryKey: 'abc123', isRemote: true,
  name: 'advanced/mainMenu/background/hover/color',
  resolvedType: 'COLOR', libraryName: 'DS', collectionName: 'Advanced', usedCount: 1,
};

/** A component whose only bound token lives in a library, not this file. */
const boundToLibrary = initData({
  remoteVars: [remoteToken],
  // Library tokens only enter the list once a scan has gone deeper than Local.
  lastScanDepth: 2,
  hasExternalLibraries: true,
  browserComponents: [{
    nodeId: 'comp-1', nodeName: 'mainMenuBackground', nodeType: 'COMPONENT',
    pageName: 'Page 1', pageId: 'page-1', boundCount: 1,
    boundVars: [{ id: 'r-1', name: remoteToken.name, resolvedType: 'COLOR' }],
  }],
});

describe('impact-atlas UI — connectors survive a drill', () => {
  /**
   * Library tokens only enter the list once a scan has gone deeper than Local —
   * that scan result is what raises the display depth.
   */
  function afterDeeperScan(u) {
    u.receive({
      type: 'usage-scan-ready', depth: 2, instanceCounts: {}, directCounts: {}, total: 0,
      updatedComponentCounts: {}, updatedImpactScores: {},
      newLibraryComponents: [], remoteVars: [], remoteColls: [],
    });
  }

  /** Component detail → click the chevron on its bound token. */
  function drillToBoundToken(ui) {
    afterDeeperScan(ui);
    ui.click('#btn-mode-comps');
    ui.click(ui.$$('#comp-list .comp-item').find((el) => el.textContent.includes('mainMenuBackground')));
    ui.click(ui.$('#gcol-2 .node-drill-btn[data-drill-id="r-1"]'));
  }

  it('draws them after drilling into a bound token', async () => {
    ui = loadUI(UI);
    stubGeometry(ui);
    ui.receive(initData());
    ui.click('#btn-mode-comps');
    ui.click(ui.$$('#comp-list .comp-item').find((el) => el.textContent.includes('buttonPrimary')));
    ui.click(ui.$('#gcol-2 .node-drill-btn[data-drill-id="v-high"]'));
    ui.receive(chainResult());
    await new Promise((r) => setTimeout(r, 120)); // edges are drawn on a rAF

    expect(ui.$$('#cross-edges path.ce-dynamic').length).toBeGreaterThan(0);
  });

  it('does not leave the component it drilled out of selected', () => {
    ui = loadUI(UI);
    stubGeometry(ui);
    ui.receive(boundToLibrary);
    drillToBoundToken(ui);

    // A stale .comp-item selection is what breaks the connectors: drawCrossEdges
    // scopes its lookup to #var-list once the mode flips to tokens, so a surviving
    // component selection makes it find nothing and wipe every line.
    expect(ui.$$('#comp-list .comp-item.node-selected')).toHaveLength(0);
    expect(ui.$$('#var-list .var-item.node-selected')).toHaveLength(1);
  });

  it('still asks the plugin to analyse the library token', () => {
    ui = loadUI(UI);
    stubGeometry(ui);
    ui.receive(boundToLibrary);
    drillToBoundToken(ui);

    expect(ui.sentOf('analyze-remote').map((m) => m.variableId)).toEqual(['r-1']);
  });
});

describe('impact-atlas UI — external library marker', () => {
  it('marks an external token with the shared library icon, not the word', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    const external = chainResult();
    external.chain.descendants = [{ ...chainNode('v-ext', 'remote/accent'), isExternal: true }];
    ui.receive(external);

    // Every other external indicator is a tooltipButton carrying #icon-library;
    // this one used to be the odd one out, rendering the literal text "Library".
    const badge = ui.$('#gcol-2 .lib-badge');
    expect(badge.className).toContain('tooltipButton');
    expect(badge.querySelector('use').getAttribute('href')).toBe('#icon-library');
    expect(ui.$('#gcol-2').textContent).not.toContain('Library');
  });
});

describe('impact-atlas UI — errors', () => {
  it('surfaces a plugin error instead of failing silently', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'error', message: 'Something went wrong' });

    expect(ui.document.body.textContent).toContain('Something went wrong');
  });

  it('shows a failure as a failure, not as a success toast', () => {
    ui = loadUI(UI);
    ui.receive({ type: 'error', message: 'Something went wrong' });

    // It used to reuse the success toast, so errors arrived with a green tick.
    const toast = ui.$('.toast');
    expect(toast.className).toContain('toast-error');
    expect(toast.querySelector('use').getAttribute('href')).toBe('#icon-warning');
  });

  it('keeps confirmations on the success toast', () => {
    ui = loadUI(UI);
    ui.receive(initData());
    ui.receive(chainResult());
    ui.receive({ type: 'place-done', placed: 3, skipped: 0, truncated: 0, pageName: 'Impact Atlas Previews' });

    const toast = ui.$('.toast');
    expect(toast.className).not.toContain('toast-error');
    expect(toast.querySelector('use').getAttribute('href')).toBe('#icon-check');
  });
});
