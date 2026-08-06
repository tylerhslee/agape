const NODE_WIDTH = 248;
const NODE_HEIGHT = 118;
const COL_GAP = 86;
const ROW_GAP = 30;
const PAD = 42;
export const FLOW_KINDS = ['prompt', 'agent', 'model', 'decision', 'endorsement', 'action', 'event', 'output', 'program', 'function', 'handler', 'hook', 'principal', 'memory', 'ledger', 'tool'];

export function layoutFlow(nodes, edges) {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source).push(edge.target);
    incoming.get(edge.target).push(edge.source);
  }

  // Kahn gives the readable dependency layers. Cycles and detached nodes are
  // placed after the acyclic portion instead of disappearing from the canvas.
  const pending = new Map([...incoming].map(([id, parents]) => [id, parents.length]));
  const layer = new Map();
  const queue = nodes.filter((node) => pending.get(node.id) === 0).map((node) => node.id);
  for (const id of queue) layer.set(id, 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    for (const target of outgoing.get(id)) {
      layer.set(target, Math.max(layer.get(target) || 0, (layer.get(id) || 0) + 1));
      pending.set(target, pending.get(target) - 1);
      if (pending.get(target) === 0) queue.push(target);
    }
  }
  let fallbackLayer = Math.max(0, ...layer.values()) + 1;
  for (const node of nodes) if (!layer.has(node.id)) layer.set(node.id, fallbackLayer);

  const rows = new Map();
  return Object.fromEntries(nodes.map((node) => {
    const col = layer.get(node.id);
    const row = rows.get(col) || 0;
    rows.set(col, row + 1);
    return [node.id, node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
      ? node.position
      : { x: PAD + col * (NODE_WIDTH + COL_GAP), y: PAD + row * (NODE_HEIGHT + ROW_GAP) }];
  }));
}

export function visibleFlow(nodes, edges, { query = "", kinds = FLOW_KINDS, focusId = null } = {}) {
  const enabled = new Set(kinds);
  const needle = query.trim().toLowerCase();
  let focus = null;
  if (focusId) {
    focus = new Set([focusId]);
    for (const edge of edges) {
      if (edge.source === focusId) focus.add(edge.target);
      if (edge.target === focusId) focus.add(edge.source);
    }
  }
  const shownNodes = nodes.filter((node) => {
    if (!enabled.has(node.kind) || (focus && !focus.has(node.id))) return false;
    if (!needle) return true;
    return [node.label, node.kind, ...((node.fields || []).map((field) => field.value))]
      .some((value) => String(value ?? "").toLowerCase().includes(needle));
  });
  const shownIds = new Set(shownNodes.map((node) => node.id));
  return {
    nodes: shownNodes,
    edges: edges.filter((edge) => shownIds.has(edge.source) && shownIds.has(edge.target)),
  };
}

export function canvasBounds(nodes, positions) {
  let width = 760;
  let height = 520;
  for (const node of nodes) {
    const p = positions[node.id] || { x: PAD, y: PAD };
    width = Math.max(width, p.x + NODE_WIDTH + PAD);
    height = Math.max(height, p.y + NODE_HEIGHT + PAD);
  }
  return { width, height };
}

export function edgePath(edge, positions) {
  const source = positions[edge.source];
  const target = positions[edge.target];
  if (!source || !target) return "";
  const x1 = source.x + NODE_WIDTH;
  const y1 = source.y + NODE_HEIGHT / 2;
  const x2 = target.x;
  const y2 = target.y + NODE_HEIGHT / 2;
  const bend = Math.max(42, Math.abs(x2 - x1) * 0.42);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function changedFields(document, draft) {
  const changes = [];
  for (const node of document?.nodes || []) {
    for (const field of node.fields || []) {
      const key = `${node.id}:${field.key}`;
      if (Object.prototype.hasOwnProperty.call(draft, key) && draft[key] !== field.value) {
        changes.push({ nodeId: node.id, field: field.key, value: draft[key] });
      }
    }
  }
  return changes;
}

export function kindIcon(kind) {
  return ({ prompt: 'ti-message-question', agent: 'ti-robot', model: 'ti-sparkles', decision: 'ti-filter-check',
    endorsement: 'ti-shield-check', action: 'ti-bolt', event: 'ti-radio', output: 'ti-arrow-bar-to-right',
    program: 'ti-app-window', function: 'ti-function', handler: 'ti-route-alt-left', hook: 'ti-anchor',
    principal: 'ti-user-shield', memory: 'ti-database', ledger: 'ti-book-2', tool: 'ti-tool' })[kind] || 'ti-box';
}

export const FLOW_NODE_SIZE = { width: NODE_WIDTH, height: NODE_HEIGHT };
