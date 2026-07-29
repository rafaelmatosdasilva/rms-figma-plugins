/**
 * Wait until `predicate` returns something truthy, or fail after `timeout`.
 *
 * Some handlers kick off work without awaiting it (tokens-to-ink's runScan is
 * fire-and-forget, font-scaling-lab posts panel widths from a .then()), so
 * `await send(...)` can return before the plugin has posted anything. Polling
 * across macrotasks is the honest way to wait for those.
 */
export async function waitFor(predicate, { timeout = 2000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Let pending microtasks and one macrotask turn drain. */
export async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * A promise you resolve by hand, for suspending a handler mid-flight.
 *
 * Cancellation is only observable if the work is still running when the cancel
 * arrives. With an all-synchronous mock a whole scan can finish inside one
 * microtask drain, so tests gate an API the handler awaits:
 *
 *   const gate = makeGate();
 *   frame.exportAsync = async () => { await gate.promise; return bytes; };
 *   const inFlight = send({ type: 'preview', scale: 2 });
 *   await send({ type: 'preview-cancel' });
 *   gate.open();
 *   await inFlight;
 */
export function makeGate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open: () => open() };
}
