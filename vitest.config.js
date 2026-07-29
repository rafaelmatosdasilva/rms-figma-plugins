import { defineConfig } from 'vitest/config';

// Plugin backends are ESM modules that run against a mocked `figma` global, so the
// node environment is enough — no DOM. Real timers: the handlers await yieldTick()
// (a real setTimeout), and faking them would stall every scan/place loop.
export default defineConfig({
  test: {
    environment: 'node',
    // apps/**  — per-plugin backend tests
    // test/**  — repo-wide checks that span plugins (UI contract, wiring)
    include: ['apps/**/test/**/*.test.js', 'test/**/*.test.js'],
    testTimeout: 20000,
  },
});
