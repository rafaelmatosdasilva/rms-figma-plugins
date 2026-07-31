// Synthetic scene-graph nodes for tests.
//
// These are plain objects that implement just enough of the Figma node API for the
// plugin backends to traverse them: the type/name/id trio, parent/children links,
// findAllWithCriteria, plugin data, and the geometry/append surface that generated
// content (frames, sections, instances) is asserted against.
//
// Everything here is invented — no real design-system data.

let _autoId = 0;
function nextId(prefix) {
  _autoId += 1;
  return `${prefix}:${_autoId}`;
}

/** Reset id numbering so ids are deterministic per test. */
export function resetIds() {
  _autoId = 0;
}

const BINDING_LIKE = new Set([
  'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'RECTANGLE', 'ELLIPSE', 'POLYGON',
  'STAR', 'LINE', 'VECTOR', 'BOOLEAN_OPERATION', 'TEXT', 'SLOT', 'SECTION', 'GROUP',
]);

/** Depth-first walk of a node's descendants (excluding the node itself). */
function* walk(node) {
  for (const child of node.children || []) {
    yield child;
    yield* walk(child);
  }
}

/**
 * Base node. `props` can carry anything the plugin reads — boundVariables, fills,
 * characters, remote/key, geometry, etc.
 */
export function makeNode(type, props = {}) {
  // `children` is kept out of the spread on purpose: spreading it would alias the
  // caller's array as node.children, and the appendChild loop below would then push
  // into the very array it iterates — duplicating every child.
  const { children: initialChildren = [], ...rest } = props;

  const node = {
    id: props.id || nextId(type.toLowerCase()),
    type,
    name: props.name || type,
    visible: props.visible !== false,
    parent: null,
    x: props.x ?? 0,
    y: props.y ?? 0,
    width: props.width ?? 100,
    height: props.height ?? 40,
    fills: props.fills ?? [],
    remote: props.remote ?? false,
    key: props.key ?? null,
    ...rest,
    children: [],

    // Real nodes always carry a transform, and reparenting code reads
    // absoluteTransform[0][2] / [1][2] unguarded — so the mock must have one.
    // Derived from x/y unless the fixture pinned its own.
    get absoluteTransform() {
      return rest.absoluteTransform || [[1, 0, node.x || 0], [0, 1, node.y || 0]];
    },

    appendChild(child) {
      if (child.parent) {
        const siblings = child.parent.children;
        const i = siblings.indexOf(child);
        if (i !== -1) siblings.splice(i, 1);
      }
      child.parent = node;
      node.children.push(child);
      return child;
    },
    remove() {
      if (node.parent) {
        const siblings = node.parent.children;
        const i = siblings.indexOf(node);
        if (i !== -1) siblings.splice(i, 1);
      }
      node.removed = true;
    },
    resize(w, h) { node.width = w; node.height = h; },
    resizeWithoutConstraints(w, h) { node.width = w; node.height = h; },
    findAllWithCriteria({ types, pluginData } = {}) {
      let found = [...walk(node)];
      // A pluginData criterion selects by key regardless of node type — the real API
      // does not restrict it to binding-like nodes, and the orphan-clone sweep relies
      // on that. Only fall back to BINDING_LIKE when neither criterion is given.
      if (pluginData && Array.isArray(pluginData.keys)) {
        found = found.filter((n) => pluginData.keys.some((k) => n.getPluginData(k) !== ''));
      } else if (!types) {
        found = found.filter((n) => BINDING_LIKE.has(n.type));
      }
      if (types) {
        const want = new Set(types);
        found = found.filter((n) => want.has(n.type));
      }
      return found;
    },
    findAll(fn) {
      return [...walk(node)].filter((n) => (fn ? fn(n) : true));
    },
    getPluginData(key) { return node._pluginData?.[key] ?? ''; },
    setPluginData(key, value) {
      node._pluginData = node._pluginData || {};
      node._pluginData[key] = value;
    },
    // Figma's clone() deep-copies the subtree and leaves the original untouched.
    // A shallow copy that re-appends the same child objects would MOVE them out of
    // the original (appendChild re-parents), silently gutting the fixture.
    clone() { return deepCloneNode(node); },
    async exportAsync() { return new Uint8Array([1, 2, 3]); },
  };

  for (const child of initialChildren) node.appendChild(child);
  return node;
}

/**
 * Deep-copy a node and its subtree into fresh nodes, as Figma's clone() does.
 * The copy is detached (no parent) — callers append it where they need it.
 */
export function deepCloneNode(node) {
  const { children, parent, id, _pluginData, ...rest } = node;
  const copy = makeNode(node.type, {
    ...rest,
    id: nextId(`${node.type.toLowerCase()}-clone`),
    children: [],
  });
  if (_pluginData) copy._pluginData = { ..._pluginData };
  for (const child of node.children || []) copy.appendChild(deepCloneNode(child));
  return copy;
}

/** A page. Pages are the roots the plugins iterate via figma.root.children. */
export function makePage(name, children = []) {
  const page = makeNode('PAGE', { id: nextId('page'), name, width: 0, height: 0 });
  // Count loads so tests can prove a code path doesn't bulk-load pages — doing that
  // in the background once pulled in other files' data and thrashed the caches.
  page.loadCount = 0;
  page.loadAsync = async () => { page.loadCount += 1; };
  page.selection = [];
  for (const child of children) page.appendChild(child);
  return page;
}

/**
 * A component master. `boundVariables` binds it to token ids, e.g.
 * makeComponent('button', { boundVariables: { fills: [{ id: 'v1' }] } }).
 */
export function makeComponent(name, props = {}) {
  return makeNode(props.type || 'COMPONENT', { name, ...props });
}

/** A component set (variant container). Its children are the variants. */
export function makeComponentSet(name, props = {}) {
  return makeNode('COMPONENT_SET', { name, ...props });
}

/**
 * An instance on the canvas. `main` is the component master it points at — the
 * backends resolve it through getMainComponentAsync().
 */
export function makeInstance(main, props = {}) {
  const inst = makeNode('INSTANCE', { name: props.name || `${main.name} instance`, ...props });
  inst.getMainComponentAsync = async () => main;
  return inst;
}

/** A text node — font-scaling-lab reads characters/fontSize. */
export function makeText(characters, props = {}) {
  return makeNode('TEXT', { name: props.name || characters.slice(0, 20), characters, ...props });
}
