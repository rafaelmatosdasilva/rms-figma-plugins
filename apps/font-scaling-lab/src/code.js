import { attachWindowResize } from '@rms/core';

figma.showUI(__html__, { width: 720, height: 860, title: 'Font Scaling Lab' });

const handleResizeMsg = attachWindowResize(figma, { defaultW: 720, defaultH: 860, minW: 480, maxW: 1400, minH: 160, maxH: 900 });

// Clean up any scout clones left over from a previous crash or force-quit.
// Under documentAccess:"dynamic-page", findAllWithCriteria throws on a page that
// isn't loaded, so we can't walk figma.root.children. Clones are always created on
// the current page anyway — sweep it now, and sweep each page as it's visited.
function sweepCurrentPageClones() {
  try {
    figma.currentPage.findAllWithCriteria({ pluginData: { keys: ['_scoutClone'] } })
      // Native prefilter to nodes that HAVE the key (fast); exact value check kept as
      // post-filter — provably the same set as findAll(n => getPluginData(...) === '1').
      .filter(n => n.getPluginData('_scoutClone') === '1')
      .forEach(n => { try { n.remove(); } catch (_) {} });
  } catch (_) {}
}
sweepCurrentPageClones();
figma.on('currentpagechange', sweepCurrentPageClones);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPageForNode(node) {
  let p = node;
  while (p && p.type !== 'PAGE') p = p.parent;
  return p && p.type === 'PAGE' ? p : null;
}

// ─── Variable resolution ──────────────────────────────────────────────────────

async function resolveVarValue(variable, modeId, depth) {
  if (depth > 10) return null;
  const raw = variable.valuesByMode[modeId];
  if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') {
    const next = await figma.variables.getVariableByIdAsync(raw.id);
    if (!next) return null;
    const coll = await figma.variables.getVariableCollectionByIdAsync(next.variableCollectionId);
    return resolveVarValue(next, coll ? coll.defaultModeId : modeId, depth + 1);
  }
  return raw;
}

// async: the manifest is documentAccess:"dynamic-page", so every by-id lookup
// (variable, collection, style) must use the async API — the sync ones throw.
async function getTextFontSizeSource(node) {
  // 1. Variable binding on fontSize
  const boundVar = node.boundVariables && node.boundVariables.fontSize;
  if (boundVar) {
    try {
      const variable = await figma.variables.getVariableByIdAsync(boundVar.id);
      if (variable) {
        const coll = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
        const value = coll ? await resolveVarValue(variable, coll.defaultModeId, 0) : null;
        return { source: 'variable', value: typeof value === 'number' ? value : null, name: variable.name };
      }
    } catch (_) {}
  }

  // 2. Text style
  const styleId = node.textStyleId;
  if (styleId && styleId !== figma.mixed && styleId !== '') {
    try {
      const style = await figma.getStyleByIdAsync(styleId);
      if (style) {
        const fs = node.fontSize;
        return { source: 'style', value: fs === figma.mixed ? null : fs, name: style.name };
      }
    } catch (_) {}
  }

  // 3. Raw override
  const fs = node.fontSize;
  return { source: 'override', value: fs === figma.mixed ? null : fs };
}

// ─── Font loading ─────────────────────────────────────────────────────────────

// Collect every unique font in a node into a Set of JSON strings
function collectFonts(textNode, fontSet) {
  try {
    if (textNode.fontName === figma.mixed) {
      for (var i = 0; i < textNode.characters.length; i++) {
        const fn = textNode.getRangeFontName(i, i + 1);
        if (fn && fn !== figma.mixed) fontSet.add(JSON.stringify(fn));
      }
    } else if (textNode.fontName) {
      fontSet.add(JSON.stringify(textNode.fontName));
    }
  } catch (_) {}
}

// ─── Scale a single text node (fonts must already be loaded) ─────────────────

async function scaleTextNode(node, scale) {
  try {
  if (node.fontSize === figma.mixed) {
    let i = 0;
    const len = node.characters.length;
    while (i < len) {
      const sz = node.getRangeFontSize(i, i + 1);
      if (sz === figma.mixed || typeof sz !== 'number') { i++; continue; }
      let j = i + 1;
      while (j < len && node.getRangeFontSize(j, j + 1) === sz) j++;
      node.setRangeFontSize(i, j, Math.round(sz * scale));
      i = j;
    }
  } else if (typeof node.fontSize === 'number') {
    node.fontSize = Math.round(node.fontSize * scale);
  }

  // Scale pixel-based line height — pixel values are hardcoded distances and
  // need to grow proportionally to preserve the typographic rhythm.  PERCENT
  // and AUTO line heights are relative to font size and auto-scale already.
  // Walks per-range when the property is mixed across the string.
  try {
    const lh = node.lineHeight;
    if (lh === figma.mixed) {
      let i = 0;
      const len = node.characters.length;
      while (i < len) {
        const r = node.getRangeLineHeight(i, i + 1);
        if (r === figma.mixed || !r) { i++; continue; }
        let j = i + 1;
        const sig = r.unit + ':' + r.value;
        while (j < len) {
          const rj = node.getRangeLineHeight(j, j + 1);
          if (rj === figma.mixed || !rj || rj.unit + ':' + rj.value !== sig) break;
          j++;
        }
        if (r.unit === 'PIXELS') {
          node.setRangeLineHeight(i, j, { unit: 'PIXELS', value: Math.round(r.value * scale) });
        }
        i = j;
      }
    } else if (lh && lh.unit === 'PIXELS') {
      node.lineHeight = { unit: 'PIXELS', value: Math.round(lh.value * scale) };
    }
  } catch (_) {}

  // Scale pixel-based letter spacing the same way.  PERCENT letter spacing
  // is relative to font size — leave it alone.  Don't round (typical values
  // are fractional and rounding would shift visible kerning at small sizes).
  try {
    const ls = node.letterSpacing;
    if (ls === figma.mixed) {
      let i = 0;
      const len = node.characters.length;
      while (i < len) {
        const r = node.getRangeLetterSpacing(i, i + 1);
        if (r === figma.mixed || !r) { i++; continue; }
        let j = i + 1;
        const sig = r.unit + ':' + r.value;
        while (j < len) {
          const rj = node.getRangeLetterSpacing(j, j + 1);
          if (rj === figma.mixed || !rj || rj.unit + ':' + rj.value !== sig) break;
          j++;
        }
        if (r.unit === 'PIXELS') {
          node.setRangeLetterSpacing(i, j, { unit: 'PIXELS', value: r.value * scale });
        }
        i = j;
      }
    } else if (ls && ls.unit === 'PIXELS') {
      node.letterSpacing = { unit: 'PIXELS', value: ls.value * scale };
    }
  } catch (_) {}

  // Detect text that clips inside its own fixed box.
  // When textAutoResize is NONE or TRUNCATE, changing fontSize won't grow the node —
  // the text renders cropped but node.width/height stay fixed, so the normal ancestor
  // overflow walk never sees anything wrong. We temporarily unlock height, measure the
  // natural post-scale height, then restore the fixed box so the preview looks right.
  try {
    const ar = node.textAutoResize;
    if (ar === 'NONE' || ar === 'TRUNCATE') {
      const fixedW = node.width;
      const fixedH = node.height;
      // Check vertical overflow
      node.textAutoResize = 'HEIGHT';
      const naturalH = node.height;
      node.textAutoResize = ar;
      node.resize(fixedW, fixedH);
      // Check horizontal overflow
      node.textAutoResize = 'WIDTH_AND_HEIGHT';
      const naturalW = node.width;
      node.textAutoResize = ar;
      node.resize(fixedW, fixedH);
      const overH = naturalH > fixedH + 2;
      const overW = naturalW > fixedW + 2;
      if (overH || overW) {
        node.setPluginData('_textClips', '1');
        node.setPluginData('_textClipAxis', overW ? 'h' : 'v');
      }
    }
  } catch (_) {}
  } catch (_) {
    // Instance sublayer text — inaccessible, skip
  }
}

// ─── Scale spacing on frame/component nodes ───────────────────────────────────

function scaleSpacing(node, scale) {
  if (node.type === 'TEXT') return;
  try {
    if (typeof node.itemSpacing === 'number') {
      node.itemSpacing = Math.round(node.itemSpacing * scale);
    }
    if (typeof node.paddingTop === 'number') {
      node.paddingTop    = Math.round(node.paddingTop    * scale);
      node.paddingBottom = Math.round(node.paddingBottom * scale);
      node.paddingLeft   = Math.round(node.paddingLeft   * scale);
      node.paddingRight  = Math.round(node.paddingRight  * scale);
    }
  } catch (_) {
    // Instance sublayer — inaccessible, skip
  }
}

// ─── Create scaled clone (off-screen, never commits to real canvas state) ─────

async function createScaledClone(frame, scale) {
  // Collect original IDs before cloning so we can stamp them onto the clone nodes
  const origAll = [frame, ...frame.findAll(() => true)];

  const clone = frame.clone();
  // Everything after clone() can throw (a font that won't load, a scale step). If it
  // does, remove the clone before rethrowing so it never lingers off-screen at
  // (99999,99999) — the caller only holds a reference once this resolves.
  try {
    clone.x = 99999;
    clone.y = 99999;
    try { clone.setPluginData('_scoutClone', '1'); } catch (_) {}

    const all = [clone, ...clone.findAll(() => true)];

    // Stamp each clone node with its original id AND its original sizing mode.
    // The sizing MUST come from the original: a FILL layer that is cloned off-canvas
    // loses FILL (it needs an auto-layout parent) and silently becomes FIXED, so
    // reading layoutSizing off the clone would mislabel a fill layer as fixed-width.
    for (var i = 0; i < Math.min(origAll.length, all.length); i++) {
      try { all[i].setPluginData('_origId', origAll[i].id); } catch (_) {}
      try { var _osh = origAll[i].layoutSizingHorizontal; if (_osh) all[i].setPluginData('_origSizeH', _osh); } catch (_) {}
      try { var _osv = origAll[i].layoutSizingVertical;   if (_osv) all[i].setPluginData('_origSizeV', _osv); } catch (_) {}
    }

    // Batch-load all unique fonts in parallel before touching any text node
    const fontSet = new Set();
    for (const n of all) { if (n.type === 'TEXT') collectFonts(n, fontSet); }
    await Promise.all(Array.from(fontSet).map(function(f) { return figma.loadFontAsync(JSON.parse(f)); }));

    // Scale spacing before text reflow so auto-layout recalculates correctly
    for (const n of all) scaleSpacing(n, scale);

    for (const n of all) {
      if (n.type === 'TEXT') await scaleTextNode(n, scale);
    }

    return clone;
  } catch (err) {
    try { clone.remove(); } catch (_) {}
    throw err;
  }
}

// ─── Issue detection ──────────────────────────────────────────────────────────

async function detectIssues(clone, refNode, scaleValue, isStale) {
  const issues = [];
  const seen = new Set();
  let _visitCount = 0;

  function tag(key) {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  // Use absoluteBoundingBox — the rendered geometric rect in page space.
  // This is Figma's true post-layout rect (accounts for rotation, auto-layout
  // reflow, instance overrides, everything) and maps 1:1 to the export PNG
  // when paired with useAbsoluteBounds:true. absoluteTransform only gives the
  // local origin translation, which drifts the moment anything rotates or
  // overflow extends the rendered region.
  // refNode (if provided) is the actual exported wrapper — overlay positions
  // are relative to ITS origin so they match the PNG content.
  const cloneBox = ((refNode || clone) && (refNode || clone).absoluteBoundingBox) || clone.absoluteBoundingBox;
  function relativeBounds(node) {
    try {
      const nb = node.absoluteBoundingBox;
      if (!nb || !cloneBox) return null;
      return {
        x: nb.x - cloneBox.x,
        y: nb.y - cloneBox.y,
        w: nb.width,
        h: nb.height,
      };
    } catch (_) { return null; }
  }

  // Auto-generated layer names from Figma — useless as labels
  const AUTO_NAME = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Component|Instance) \d+$/;
  function clean(name) { return (name && !AUTO_NAME.test(name)) ? name : ''; }

  // Walk up the parent chain to find the first meaningfully-named ancestor
  function meaningfulAncestor(node) {
    try {
      var p = node.parent;
      while (p && p.type !== 'PAGE') {
        var n = clean(p.name);
        if (n) return n;
        p = p.parent;
      }
    } catch (_) {}
    return '';
  }

  function ctx(node) {
    var chars = '';
    if (node.type === 'TEXT') {
      try { const raw = (node.characters || '').replace(/\s+/g, ' ').trim(); chars = raw.length > 60 ? raw.substring(0, 60) + '…' : raw; } catch (_) {}
    }
    return { parentName: meaningfulAncestor(node), chars: chars };
  }

  // Inspect a flagged node and produce human-readable reasons + suggested fixes.
  // Each reason explains a single Figma property that's preventing the layer
  // from adapting to scaled content, plus the property setting that would fix it.
  function diagnose(node) {
    const out = [];
    try {
      // Text-only: Auto-resize mode controls whether the text box grows with content
      if (node.type === 'TEXT') {
        try {
          const ar = node.textAutoResize;
          if (ar === 'NONE') {
            out.push({ what: 'Auto resize: Fixed size', fix: 'Set to “Width and height”' });
          } else if (ar === 'TRUNCATE') {
            out.push({ what: 'Auto resize: Truncate', fix: 'Set to “Width and height”' });
          } else if (ar === 'HEIGHT') {
            out.push({ what: 'Auto resize: Height only', fix: 'Set to “Width and height” if width should grow' });
          }
        } catch (_) {}
        // Newer API: textTruncation can be set independently of textAutoResize
        try {
          if (node.textTruncation === 'ENDING') {
            out.push({ what: 'Truncate text: On', fix: 'Turn truncation off so all text stays visible' });
          }
        } catch (_) {}
        // Hard cap on number of lines clips overflow even when the box can grow
        try {
          if (typeof node.maxLines === 'number' && node.maxLines > 0) {
            out.push({ what: 'Max lines: ' + node.maxLines, fix: 'Remove or raise the max-lines limit' });
          }
        } catch (_) {}
      }

      // Width/Height locked to a fixed value — uses the same axisFixed
      // logic as the container-overflow flagger so detection and diagnostic
      // stay in sync. Modern layoutSizing* is authoritative; legacy primary/
      // counter axis modes are only a fallback when layoutSizing* is unset.
      var hFix = false, vFix = false;
      var hHas = false, vHas = false;
      try {
        if (node.layoutSizingHorizontal != null) { hHas = true; hFix = node.layoutSizingHorizontal === 'FIXED'; }
        if (node.layoutSizingVertical   != null) { vHas = true; vFix = node.layoutSizingVertical   === 'FIXED'; }
      } catch (_) {}
      if (!hHas || !vHas) {
        try {
          if (node.layoutMode === 'HORIZONTAL') {
            if (!hHas && node.primaryAxisSizingMode === 'FIXED') hFix = true;
            if (!vHas && node.counterAxisSizingMode === 'FIXED') vFix = true;
          } else if (node.layoutMode === 'VERTICAL') {
            if (!vHas && node.primaryAxisSizingMode === 'FIXED') vFix = true;
            if (!hHas && node.counterAxisSizingMode === 'FIXED') hFix = true;
          }
        } catch (_) {}
      }
      if (hFix) out.push({ what: 'Width: Fixed',  fix: 'Set to Hug or Fill container' });
      if (vFix) out.push({ what: 'Height: Fixed', fix: 'Set to Hug or Fill container' });

      // Horizontal auto-layout that can't wrap — when children exceed the
      // available width, enabling Wrap lets them flow onto the next line
      // instead of overflowing.  Only meaningful with 2+ children.
      try {
        if (node.layoutMode === 'HORIZONTAL'
            && node.layoutWrap === 'NO_WRAP'
            && node.children && node.children.length > 1) {
          out.push({ what: 'Wrap: Off', fix: 'Enable Wrap so children flow to the next line' });
        }
      } catch (_) {}

      // Frame-like node not using Auto layout — can't reflow children
      if ((node.type === 'FRAME' || node.type === 'COMPONENT'
        || node.type === 'INSTANCE' || node.type === 'COMPONENT_SET')
          && node.layoutMode === 'NONE') {
        out.push({ what: 'Auto layout: Off', fix: 'Enable Auto layout so the container can adapt' });
      }

      // Explicit max-width / max-height ceilings on an auto-layout child cap
      // its growth even when sizing is Hug or Fill.
      try {
        if (typeof node.maxWidth === 'number' && node.maxWidth > 0) {
          out.push({ what: 'Max width: ' + Math.round(node.maxWidth), fix: 'Remove the max-width to allow the layer to grow' });
        }
        if (typeof node.maxHeight === 'number' && node.maxHeight > 0) {
          out.push({ what: 'Max height: ' + Math.round(node.maxHeight), fix: 'Remove the max-height to allow the layer to grow' });
        }
      } catch (_) {}

      // Frame clips content — the overflow is hidden, not fixed
      try {
        if ((node.type === 'FRAME' || node.type === 'COMPONENT'
          || node.type === 'INSTANCE' || node.type === 'COMPONENT_SET')
            && node.clipsContent === true) {
          out.push({ what: 'Clip content: On', fix: 'Clipping hides the overflow. Fix the sizing instead.' });
        }
      } catch (_) {}

      // Non-auto-layout child with a constraint that doesn't stretch — the
      // child stays its original width inside its growing parent.
      try {
        const c = node.constraints;
        const parentHasAL = node.parent && node.parent.layoutMode && node.parent.layoutMode !== 'NONE';
        if (c && !parentHasAL) {
          if (c.horizontal === 'LEFT' || c.horizontal === 'RIGHT' || c.horizontal === 'CENTER') {
            out.push({ what: 'Horizontal constraint: ' + c.horizontal, fix: 'Use Left & Right (stretch) or Scale so it follows parent width' });
          }
          if (c.vertical === 'TOP' || c.vertical === 'BOTTOM' || c.vertical === 'CENTER') {
            out.push({ what: 'Vertical constraint: ' + c.vertical, fix: 'Use Top & Bottom (stretch) or Scale so it follows parent height' });
          }
        }
      } catch (_) {}
    } catch (_) {}
    return out;
  }

  function composeDescription(node, severity, overflowAxis) {
    const pct = typeof scaleValue === 'number' ? Math.round(scaleValue * 100) : null;
    const sevText = severity === 'truncation' ? 'gets cut off' : 'is clipped by its container';
    const scaleTail = pct && pct !== 100 ? ' at ' + pct + '% scale' : '';
    var w = 0, h = 0;
    try { w = Math.round(node.width); } catch (_) {}
    try { h = Math.round(node.height); } catch (_) {}
    const f = axisFixed(node);
    // Describe the axis that actually overflowed, so the message and the suggested
    // fixes never disagree. Only call it "fixed" when that axis is genuinely fixed.
    const fixedH = 'This layer has a fixed width of ' + w + 'px that prevents content from flowing, so content ' + sevText + scaleTail + '.';
    const fixedV = 'This layer has a fixed height of ' + h + 'px that prevents content from growing, so content ' + sevText + scaleTail + '.';
    if (overflowAxis === 'h' && f.h && w) return fixedH;
    if (overflowAxis === 'v' && f.v && h) return fixedV;
    if (!overflowAxis) {
      if (f.h && w) return fixedH;
      if (f.v && h) return fixedV;
    }
    return 'Content extends past this layer' + scaleTail + ' and ' + sevText + '.';
  }

  // Fixes are scoped to the single sizing constraint that causes the
  // typography to break at scale. No content, structure, or padding changes.
  const FIX_BANK = {
    fixedH: [
      { title: 'Set layer width to Hug',  description: 'The layer sizes to its own content.' },
      { title: 'Set layer width to Fill', description: 'The layer matches its parent’s width.' },
    ],
    fixedV: [
      { title: 'Set layer height to Hug',  description: 'The layer sizes to its own content.' },
      { title: 'Set layer height to Fill', description: 'The layer matches its parent’s height.' },
    ],
    overflow: [
      { title: 'Set layer width to Hug',   description: 'The layer sizes to its content horizontally.' },
      { title: 'Set layer height to Hug',  description: 'The layer sizes to its content vertically.' },
    ],
  };

  // overflowAxis ('h' | 'v' | undefined): the axis that actually overflowed. When
  // known it drives the recommendation, so a horizontal overflow never gets
  // height-only advice. Falls back to the fixed-axis heuristic when unknown.
  function buildSuggestedFixes(node, severity, origId, overflowAxis) {
    if (node.type === 'TEXT') {
      var ar = null, trunc = null, maxL = 0, clips = false;
      try { ar    = node.textAutoResize; }  catch (_) {}
      try { trunc = node.textTruncation; }  catch (_) {}
      try { maxL  = node.maxLines || 0; }   catch (_) {}
      try { clips = node.getPluginData('_textClips') === '1'; } catch (_) {}

      // ── Text-node-level causes ────────────────────────────────────────────
      if (maxL > 0) {
        return [
          { title: 'Remove the line cap',           description: 'Every line stays visible at any scale.', recommended: true, nodeId: origId },
          { title: 'Set text resize to Hug height', description: 'Keeps the line cap but lets the box grow.' },
        ];
      }
      if (trunc === 'ENDING' || ar === 'TRUNCATE') {
        return [
          { title: 'Turn off truncation',           description: 'All the text stays readable.', recommended: true, nodeId: origId },
          { title: 'Set text resize to Hug height', description: 'The text box grows tall enough to fit every line.' },
        ];
      }
      if (ar === 'NONE') {
        var clipAxis = null;
        try { clipAxis = node.getPluginData('_textClipAxis'); } catch (_) {}
        if (clipAxis === 'h') {
          var parentNode2 = null, parentOrigId2 = null;
          try { parentNode2 = node.parent; } catch (_) {}
          if (parentNode2) try { parentOrigId2 = parentNode2.getPluginData('_origId') || null; } catch (_) {}
          return [
            { title: 'Set parent width to Hug',      description: 'The container sizes to the text it holds.', recommended: true, nodeId: parentOrigId2 || origId },
            { title: 'Set text resize to Width & Height', description: 'The text box grows on both axes with its content.' },
          ];
        }
        return [
          { title: 'Set text resize to Hug',        description: 'The text box sizes to its content on both axes.', recommended: true, nodeId: origId },
          { title: 'Set text resize to Hug height', description: 'Width stays fixed and only height grows.' },
        ];
      }

      // ── Text is already flexible — the parent container is the constraint ─
      var parentNode = null;
      try { parentNode = node.parent; } catch (_) {}
      var pf = { h: false, v: false };
      var parentOrigId = null;
      if (parentNode) {
        try { pf = axisFixed(parentNode); } catch (_) {}
        try { parentOrigId = parentNode.getPluginData('_origId') || null; } catch (_) {}
      }
      // The axis that overflowed wins over which axis merely happens to be fixed.
      var preferH = overflowAxis === 'h' || (overflowAxis == null && pf.h);
      var preferV = overflowAxis === 'v' || (overflowAxis == null && pf.v);
      if (preferH) {
        return [
          { title: 'Set parent width to Hug',  description: 'The container sizes to the text it holds.', recommended: true, nodeId: parentOrigId || origId },
          { title: 'Set parent width to Fill', description: 'The container matches its own parent’s width.' },
        ];
      }
      if (preferV) {
        return [
          { title: 'Set parent height to Hug',  description: 'The container sizes to the text it holds.', recommended: true, nodeId: parentOrigId || origId },
          { title: 'Set parent height to Fill', description: 'The container matches its own parent’s height.' },
        ];
      }
      return [
        { title: 'Set text resize to Hug height', description: 'The text box grows with its content.', recommended: true, nodeId: origId },
        { title: 'Set parent height to Hug',      description: 'The container sizes to the text it holds.' },
      ];
    }
    // A max-width/height cap is a distinct root cause: Hug still respects the cap,
    // so the fix is to raise or remove it — not to change the sizing mode.
    var maxOnAxis = null;
    try { maxOnAxis = overflowAxis === 'h' ? node.maxWidth : (overflowAxis === 'v' ? node.maxHeight : null); } catch (_) {}
    if (maxOnAxis != null) {
      var dim = overflowAxis === 'h' ? 'width' : 'height';
      return [
        { title: 'Raise or remove the max ' + dim, description: 'This max ' + dim + ' (' + Math.round(maxOnAxis) + ') caps the layer, so the content clips at this scale.', recommended: true, nodeId: origId },
        { title: 'Set ' + dim + ' to Hug',         description: 'Sizes to content, within any remaining cap.' },
      ];
    }
    var f = { h: false, v: false };
    try { f = axisFixed(node); } catch (_) {}
    // Prefer the axis that overflowed; fall back to the fixed axis when unknown.
    // ('overflow' is the generic both-axes-flexible advice.)
    var axisKey;
    if (overflowAxis === 'h')      axisKey = 'fixedH';
    else if (overflowAxis === 'v') axisKey = 'fixedV';
    else                           axisKey = f.h ? 'fixedH' : (f.v ? 'fixedV' : 'overflow');
    return FIX_BANK[axisKey].map(function (fix, i) {
      return i === 0
        ? { title: fix.title, description: fix.description, recommended: true, nodeId: origId }
        : { title: fix.title, description: fix.description };
    });
  }

  function push(type, node, outOfBounds, overflowAxis) {
    var c = ctx(node);
    // If specific reasons couldn't be derived, surface a generic fallback so
    // the user always sees something actionable in the details panel.
    var reasons = diagnose(node);
    if (!reasons.length) {
      if (node.type === 'TEXT') {
        reasons.push({ what: 'Text exceeds its box', fix: 'Allow the text or its container to adapt (Hug)' });
      } else {
        reasons.push({ what: 'Content overflows this layer', fix: 'Allow the layer to adapt to its content (Hug / Auto layout)' });
      }
    }

    // ── Severity: truncation (silent data loss) vs overflow (visible break) ──
    // Truncation = the content is hidden, so the designer can't see what's
    // missing.  Higher priority to fix than a visible overflow.
    var severity = 'clipped';
    try {
      if (node.type === 'TEXT') {
        if (node.getPluginData('_textClips') === '1') severity = 'clipped';
        else if (node.textAutoResize === 'TRUNCATE') severity = 'truncation';
        else if (node.textTruncation === 'ENDING') severity = 'truncation';
        else if (typeof node.maxLines === 'number' && node.maxLines > 0) severity = 'truncation';
      }
    } catch (_) {}

    const origId = node.getPluginData('_origId') || null;
    issues.push({
      type:        type,
      severity:    severity,
      name:        clean(node.name),
      chars:       c.chars,
      parentName:  c.parentName,
      bounds:      relativeBounds(node),
      nodeId:      origId,
      outOfBounds: outOfBounds || false,
      reasons:     reasons,
      description: composeDescription(node, severity, overflowAxis),
      kind:        node.type, // drives the details-panel type icon
      suggestedFixes: buildSuggestedFixes(node, severity, origId, overflowAxis),
    });
  }

  function axisFixed(n) {
    // Returns { h: bool, v: bool } — true if that axis is fixed (not Hug/Fill).
    // Prefer the original sizing captured before cloning: the off-canvas clone
    // loses FILL and reports FIXED, so its live layoutSizing lies. Fall back to the
    // live values (and legacy axis modes) only when no stamp is present.
    var osh = null, osv = null;
    try { osh = n.getPluginData('_origSizeH'); } catch (_) {}
    try { osv = n.getPluginData('_origSizeV'); } catch (_) {}
    if (osh || osv) return { h: osh === 'FIXED', v: osv === 'FIXED' };

    var h = false, v = false;
    var hHas = false, vHas = false;
    try {
      if (n.layoutSizingHorizontal != null) { hHas = true; h = n.layoutSizingHorizontal === 'FIXED'; }
      if (n.layoutSizingVertical   != null) { vHas = true; v = n.layoutSizingVertical   === 'FIXED'; }
    } catch (_) {}
    if (!hHas || !vHas) {
      try {
        if (n.layoutMode === 'HORIZONTAL') {
          if (!hHas && n.primaryAxisSizingMode === 'FIXED') h = true;
          if (!vHas && n.counterAxisSizingMode === 'FIXED') v = true;
        } else if (n.layoutMode === 'VERTICAL') {
          if (!vHas && n.primaryAxisSizingMode === 'FIXED') v = true;
          if (!hHas && n.counterAxisSizingMode === 'FIXED') h = true;
        }
      } catch (_) {}
    }
    return { h: h, v: v };
  }
  // Root-cause walker. Walks the WHOLE ancestor chain and returns the ancestor that
  // most tightly caps `axis` ('h'|'v') — the binding bottleneck to change. A cap is a
  // FIXED size on that axis OR a maxWidth/maxHeight. Hug/Fill containers in between
  // just pass the constraint through, so they're skipped. Capacity = the ancestor's
  // rendered size on the axis (already reflects the cap), clamped by any explicit max.
  // Returns null when nothing on the chain caps the axis.
  function tightestCapOnAxis(startNode, axis) {
    var best = null, bestCap = Infinity;
    var a;
    try { a = startNode.parent; } catch (_) { return null; }
    while (a) {
      var isRoot = (a === clone);
      var af = { h: false, v: false };
      try { af = axisFixed(a); } catch (_) {}
      var maxProp = null;
      try { maxProp = axis === 'h' ? a.maxWidth : a.maxHeight; } catch (_) {}
      // A cap is a genuinely FIXED size on the axis (read from the original sizing,
      // so a FILL layer is never mistaken for fixed) or a maxWidth/maxHeight. The
      // previewed root counts too, but only when it is truly fixed — a FILL root's
      // width comes from its parent, outside this selection, so it isn't the cause.
      var isCap = (axis === 'h' ? af.h : af.v) || (maxProp != null);
      if (isCap) {
        var cap = Infinity;
        try {
          var box = a.absoluteBoundingBox;
          cap = box ? (axis === 'h' ? box.width : box.height) : (axis === 'h' ? a.width : a.height);
        } catch (_) {}
        if (maxProp != null && maxProp < cap) cap = maxProp;
        if (cap < bestCap) { bestCap = cap; best = a; }
      }
      if (isRoot) break;
      try { a = a.parent; } catch (_) { break; }
    }
    return best;
  }
  // Tracks containers flagged as the overflowing layer — descendants of these
  // are NOT individually flagged, because the issue is the container, not the
  // child. The child has the right properties (Hug/Fill); only the wrapper
  // needs to change.
  const flaggedContainers = new Set();

  function insideFlaggedContainer(node) {
    var anc = node.parent;
    while (anc && anc !== clone) {
      if (flaggedContainers.has(anc.id)) return true;
      anc = anc.parent;
    }
    return false;
  }

  async function visit(node) {
    _visitCount++;
    if (_visitCount % 50 === 0) {
      await new Promise(r => setTimeout(r, 0));
      if (isStale && isStale()) return;
    }
    try { if (node.visible === false) return; } catch (_) { return; }
    let parent;
    try { parent = node.parent; } catch (_) { return; } // instance sublayer — skip

    // Text-specific: own fixed box truncates content (independent of containers)
    if (node.type === 'TEXT') {
      try {
        if (node.getPluginData('_textClips') === '1' && tag('clipped-' + node.id)) {
          push('clipped', node);
        }
      } catch (_) {}
    }

    // Out-of-bounds: text rect escapes an ancestor's bounds.
    // If the text is already flexible (Hug / WIDTH_AND_HEIGHT), the root cause
    // is the ancestor container that has a fixed size — flag the container.
    // If the text itself is fixed, the text layer is the issue — flag the text.
    if (node.type === 'TEXT' && node !== clone && !insideFlaggedContainer(node)) {
      try {
        const nb = node.absoluteBoundingBox;
        if (nb) {
          var anc = node.parent;
          // Include the previewed root frame (clone) as the final ancestor to test:
          // when every container in between hugs, the content overflows only the root,
          // and the root's own fixed size (or an instance size override) is the cause.
          while (anc) {
            var ancIsRoot = (anc === clone);
            const ab = anc.absoluteBoundingBox;
            if (ab) {
              if (nb.x + nb.width  > ab.x + ab.width  + 2 ||
                  nb.y + nb.height > ab.y + ab.height + 2 ||
                  nb.x < ab.x - 2 ||
                  nb.y < ab.y - 2) {
                // Which axis actually overflowed — the fix must target THIS, not
                // whichever axis merely happens to be fixed. Larger escape wins; ties → width.
                var hOver = Math.max((nb.x + nb.width) - (ab.x + ab.width), ab.x - nb.x);
                var vOver = Math.max((nb.y + nb.height) - (ab.y + ab.height), ab.y - nb.y);
                var overflowAxis = hOver >= vOver ? 'h' : 'v';
                // Overflow against the previewed ROOT on a non-fixed axis is a preview
                // artifact: off-canvas the root can't FILL its (absent) parent, so it
                // renders fixed and the content appears to spill. Its real size comes
                // from the parent, outside this selection, so don't flag it.
                if (ancIsRoot) {
                  var rf = axisFixed(clone);
                  if (!(overflowAxis === 'h' ? rf.h : rf.v)) break;
                }
                // Only delegate to a container/root when the text can auto-resize
                // (Height / Width&Height). A NONE/TRUNCATE text has a fixed box, so its
                // own box is the constraint and it stays the culprit.
                var textAr = null;
                try { textAr = node.textAutoResize; } catch (_) {}
                var textIsFlexible = textAr === 'HEIGHT' || textAr === 'WIDTH_AND_HEIGHT';
                // Root cause: the tightest cap on the overflow axis anywhere up the
                // chain, including the previewed root frame (a FIXED size, a maxWidth,
                // or an instance size override). Hug/Fill containers in between just
                // pass the constraint on. Nothing caps it, the text box is the cause.
                var rootCause = textIsFlexible ? tightestCapOnAxis(node, overflowAxis) : null;
                var culprit = rootCause || node;
                var tagKey = 'clipped-' + culprit.id;
                if (tag(tagKey)) {
                  // Flag as invisible only when the node escapes the top-level clone
                  // frame itself (not just an intermediate container inside it).
                  // 'full'    — node has no overlap with the clone frame at all
                  // 'partial' — node overlaps the clone but also extends outside it
                  // false     — node is fully inside (clipsContent not set / no escape)
                  var outOfBoundsKind = false;
                  var cloneAb = null;
                  try { cloneAb = clone.absoluteBoundingBox; } catch (_) {}
                  var cloneClips = false;
                  try { cloneClips = clone.clipsContent === true; } catch (_) {}
                  if (cloneAb && cloneClips) {
                    var escapes = (
                      nb.x + nb.width  > cloneAb.x + cloneAb.width  + 2 ||
                      nb.y + nb.height > cloneAb.y + cloneAb.height + 2 ||
                      nb.x < cloneAb.x - 2 ||
                      nb.y < cloneAb.y - 2
                    );
                    if (escapes) {
                      var ix1 = Math.max(nb.x, cloneAb.x);
                      var ix2 = Math.min(nb.x + nb.width,  cloneAb.x + cloneAb.width);
                      var iy1 = Math.max(nb.y, cloneAb.y);
                      var iy2 = Math.min(nb.y + nb.height, cloneAb.y + cloneAb.height);
                      var hasIntersection = ix2 > ix1 + 2 && iy2 > iy1 + 2;
                      outOfBoundsKind = hasIntersection ? 'partial' : 'full';
                    }
                  }
                  push('clipped', culprit, outOfBoundsKind, overflowAxis);
                  flaggedContainers.add(culprit.id);
                }
                break;
              }
            }
            if (ancIsRoot) break;
            anc = anc.parent;
          }
        }
      } catch (_) {}
    }

    for (const child of (node.children || [])) await visit(child);
  }

  await visit(clone);
  return issues;
}

// ─── Selection analysis ───────────────────────────────────────────────────────

async function scanSelection() {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) return { error: 'no-selection' };
  if (sel.length > 1)   return { error: 'multi-selection' };

  const node = sel[0];
  if (!['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP'].includes(node.type)) {
    return { error: 'invalid-type' };
  }

  const textNodes = node.findAllWithCriteria({ types: ['TEXT'] }); // native type filter — same set as findAll(n => n.type === 'TEXT')
  const analyzed  = await Promise.all(textNodes.map(async n => {
    const info = await getTextFontSizeSource(n);
    return {
      id:        n.id,
      name:      n.name,
      preview:   (n.characters || '').substring(0, 30),
      source:    info.source,
      value:     info.value,
      tokenName: info.name,
    };
  }));

  const counts = { variable: 0, style: 0, override: 0 };
  for (const n of analyzed) counts[n.source] = (counts[n.source] || 0) + 1;

  return {
    nodeId: node.id,
    name:   node.name,
    type:   node.type,
    width:  Math.round(node.width),
    height: Math.round(node.height),
    total:  analyzed.length,
    counts,
    nodes:  analyzed,
  };
}

// ─── Events ───────────────────────────────────────────────────────────────────

// Node locked after first successful generate — persists across canvas selection changes
let lockedNodeId = null;

figma.on('selectionchange', () => {
  const sel = figma.currentPage.selection;
  const valid = sel.length === 1 &&
    ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP'].includes(sel[0].type);
  figma.ui.postMessage({ type: 'sel-state', valid, hasLocked: lockedNodeId != null, nodeId: valid ? sel[0].id : null });
});

// Generation token — increments on every new preview request.  In-flight work
// checks this against its captured token at each await boundary and aborts
// the moment the user cancels or starts a new scan.  Cheap, robust, and
// avoids leaving an orphan clone in the canvas.
let previewToken = 0;

figma.ui.onmessage = async (msg) => {
  if (await handleResizeMsg(msg)) return;

  if (msg.type === 'save-panel-width') {
    figma.clientStorage.setAsync('panelWidth', msg.width);
    return;
  }

  if (msg.type === 'save-details-width') {
    figma.clientStorage.setAsync('detailsWidth', msg.width);
    return;
  }

  if (msg.type === 'ready') {
    figma.ui.postMessage({ type: 'selection', data: await scanSelection() });
    figma.clientStorage.getAsync('panelWidth').then(w => {
      if (w) figma.ui.postMessage({ type: 'panel-width', width: w });
    });
    figma.clientStorage.getAsync('detailsWidth').then(w => {
      if (w) figma.ui.postMessage({ type: 'details-width', width: w });
    });
    return;
  }

  if (msg.type === 'preview-cancel') {
    // Bump the token — any in-flight preview will notice on its next check
    // and bail out (skipping further work, never sending preview-result).
    previewToken++;
    return;
  }

  if (msg.type === 'preview') {
    previewToken++;
    const myToken = previewToken;
    const isStale = () => myToken !== previewToken;
    const { scale, dpr = 2 } = msg;

    try {
      // Prefer current canvas selection; fall back to locked node from last generate.
      // getNodeByIdAsync lives inside the try so a lookup failure surfaces as an
      // error to the UI instead of throwing out of the whole handler.
      const sel = figma.currentPage.selection;
      let frame = null;
      if (sel.length === 1 && ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP'].includes(sel[0].type)) {
        frame = sel[0];
      } else if (lockedNodeId) {
        frame = await figma.getNodeByIdAsync(lockedNodeId);
      }
      if (!frame) return;

      lockedNodeId = frame.id;

      let scaledBytes, issues, frameW, frameH;

      // useAbsoluteBounds:true makes the PNG cover the node's full rendered
      // bounding box (matches absoluteBoundingBox), so overlay rects computed
      // against absoluteBoundingBox map 1:1 to image pixels.
      // PNG (not JPG) preserves transparency — white UI elements no longer
      // blend with the JPG's forced white background, and empty wrap area
      // stays transparent rather than appearing as wasted white space.
      const exportSettings = {
        format: 'PNG',
        constraint: { type: 'SCALE', value: dpr },
        useAbsoluteBounds: true,
        contentsOnly: true,
      };

      if (scale === 1) {
        scaledBytes = await frame.exportAsync(exportSettings);
        if (isStale()) return;
        issues = [];
        const fb = frame.absoluteBoundingBox;
        frameW = fb ? fb.width  : frame.width;
        frameH = fb ? fb.height : frame.height;
      } else {
        const clone = await createScaledClone(frame, scale);
        if (isStale()) { try { clone.remove(); } catch (_) {} return; }
        let wrap = null;
        try {
          // Compute union of every descendant's *rendered* bbox.  If anything
          // escapes the clone's own bounds, we wrap the clone in a transparent
          // outer frame sized to that union — the PNG export then covers all
          // overflowing content, so highlight rects don't float in empty space.
          //
          // Use absoluteBoundingBox (pure geometry — no shadow/blur extents)
          // and skip non-visible nodes plus anything inside a hidden ancestor.
          // absoluteRenderBounds would inflate the export wildly when a layer
          // has a large drop-shadow blur, so we deliberately drop that.
          function isRendered(n) {
            try { if (n.visible === false) return false; } catch (_) { return false; }
            try {
              var p = n.parent;
              while (p && p !== clone.parent && p.type !== 'PAGE') {
                if (p.visible === false) return false;
                p = p.parent;
              }
            } catch (_) {}
            return true;
          }
          const allNodes = [clone];
          try { const more = clone.findAll(() => true); for (var ai = 0; ai < more.length; ai++) allNodes.push(more[ai]); } catch (_) {}
          await new Promise(r => setTimeout(r, 0));
          if (isStale()) return;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (var ni = 0; ni < allNodes.length; ni++) {
            if (ni > 0 && ni % 50 === 0) {
              await new Promise(r => setTimeout(r, 0));
              if (isStale()) return;
            }
            const n = allNodes[ni];
            if (!isRendered(n)) continue;
            let bb = null;
            try { bb = n.absoluteBoundingBox; } catch (_) {}
            if (!bb) continue;
            if (bb.x < minX) minX = bb.x;
            if (bb.y < minY) minY = bb.y;
            if (bb.x + bb.width  > maxX) maxX = bb.x + bb.width;
            if (bb.y + bb.height > maxY) maxY = bb.y + bb.height;
          }
          const cb = clone.absoluteBoundingBox;
          const overflowsClone = cb && isFinite(minX) && (
            minX < cb.x - 0.5 || minY < cb.y - 0.5 ||
            maxX > cb.x + cb.width  + 0.5 ||
            maxY > cb.y + cb.height + 0.5
          );
          if (overflowsClone) {
            wrap = figma.createFrame();
            wrap.name = '_scaling-lab-export';
            wrap.fills = [];
            wrap.clipsContent = false;
            wrap.x = minX;
            wrap.y = minY;
            wrap.resize(maxX - minX, maxY - minY);
            try { wrap.setPluginData('_scoutClone', '1'); } catch (_) {}
            // Reparent the clone into the wrap, preserving absolute position
            const ax = clone.absoluteTransform[0][2];
            const ay = clone.absoluteTransform[1][2];
            wrap.appendChild(clone);
            clone.x = ax - wrap.absoluteTransform[0][2];
            clone.y = ay - wrap.absoluteTransform[1][2];
          }

          const refNode = wrap || clone;
          if (isStale()) return; // finally block will clean up
          issues      = await detectIssues(clone, refNode, scale, isStale);
          if (isStale()) return;
          const rb    = refNode.absoluteBoundingBox;
          frameW      = rb ? rb.width  : refNode.width;
          frameH      = rb ? rb.height : refNode.height;
          scaledBytes = await refNode.exportAsync(exportSettings);
          if (isStale()) return;
        } finally {
          if (wrap) wrap.remove(); else clone.remove();
        }
      }

      // Final stale check — don't deliver a result the user already cancelled
      if (isStale()) return;
      figma.ui.postMessage({
        type:    'preview-result',
        scale,
        name:    frame.name,
        frameId: frame.id,
        // Uint8Array travels over postMessage as-is; Array.from would 8× the memory
        // and serialisation for large exports. The UI already does new Uint8Array(bytes).
        scaled:  scaledBytes,
        issues:  issues,
        frameW:  frameW,
        frameH:  frameH,
      });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e.message || 'Preview failed' });
    }
  }

  if (msg.type === 'focus-node') {
    try {
      const node = await figma.getNodeByIdAsync(msg.nodeId);
      if (node) {
        const page = getPageForNode(node);
        if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
    } catch (err) {
      figma.ui.postMessage({ type: 'error', message: 'Focus error: ' + err.message });
    }
    return;
  }
};
