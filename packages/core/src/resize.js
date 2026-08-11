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
  // autoHeight: the UI drives height from its content (e.g. token count), so height is neither
  // restored nor persisted here — only width is remembered. Incoming ui-resize heights still apply.
  const autoHeight = !!opts.autoHeight;

  let _w = Math.min(Math.max(opts.defaultW || 480, minW), maxW);
  let _h = Math.min(Math.max(opts.defaultH || 500, minH), maxH);

  // Restore saved size on startup (width always; height only when the UI isn't auto-fitting it).
  figmaRef.clientStorage.getAsync('windowSize').then(saved => {
    if (saved && saved.w) {
      _w = Math.min(Math.max(saved.w, minW), maxW);
      if (!autoHeight && saved.h) _h = Math.min(Math.max(saved.h, minH), maxH);
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
      if (!autoHeight) _h = Math.min(Math.max(msg.height, minH), maxH);
      await figmaRef.clientStorage.setAsync('windowSize', autoHeight ? { w: _w } : { w: _w, h: _h });
      return true;
    }
    return false;
  };
}
