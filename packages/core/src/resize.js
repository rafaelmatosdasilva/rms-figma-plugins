// ── Shared window-resize handler for Figma plugin main-thread code ───────────
// Usage in code.js:
//   import { attachWindowResize } from '@rms/core';
//   const handleResizeMsg = attachWindowResize(figma, { defaultW: 460, defaultH: 560 });
//   figma.ui.onmessage = async (msg) => {
//     if (await handleResizeMsg(msg)) return;
//     // ... rest of handlers
//   };

export function attachWindowResize(figmaRef, opts) {
  opts = opts || {};
  const minW = opts.minW || 300,  maxW = opts.maxW || 1400;
  const minH = opts.minH || 160,  maxH = opts.maxH || 1200;

  let _w = Math.min(Math.max(opts.defaultW || 480, minW), maxW);
  let _h = Math.min(Math.max(opts.defaultH || 500, minH), maxH);

  // Restore saved size on startup.
  figmaRef.clientStorage.getAsync('windowSize').then(saved => {
    if (saved && saved.w && saved.h) {
      _w = Math.min(Math.max(saved.w, minW), maxW);
      _h = Math.min(Math.max(saved.h, minH), maxH);
      figmaRef.ui.resize(_w, _h);
    }
  });

  return async function handleResizeMsg(msg) {
    if (msg.type === 'ui-resize') {
      if (msg.width)  _w = Math.min(Math.max(msg.width,  minW), maxW);
      if (msg.height) _h = Math.min(Math.max(msg.height, minH), maxH);
      figmaRef.ui.resize(_w, _h);
      return true;
    }
    if (msg.type === 'save-size') {
      _w = Math.min(Math.max(msg.width,  minW), maxW);
      _h = Math.min(Math.max(msg.height, minH), maxH);
      await figmaRef.clientStorage.setAsync('windowSize', { w: _w, h: _h });
      return true;
    }
    return false;
  };
}
