// Zoom and pan for the photo viewer, with no on-screen controls:
// - trackpad pinch (arrives as ctrl+wheel; Safari sends gesture events) zooms toward the cursor
// - two-finger scroll pans once zoomed in; at 1× it scrolls the page as usual
// - mouse / one-finger drag pans once zoomed in
// - two-finger pinch on touch screens zooms
// - at 1×, a horizontal swipe calls onSwipe(+1 | -1)
//
// `frame` clips; `content` (the photo + noise canvas) gets the transform.
// The photo always covers its frame, so it can't be dragged out of view.

const SWIPE_PX = 50;

export function createZoomPan(frame, content, { maxScale = 6, onSwipe, onChange } = {}) {
  let s = 1;
  let tx = 0;
  let ty = 0;
  const pointers = new Map(); // pointerId -> [x, y] in frame coordinates
  let gesture = null;

  const local = (e) => {
    const r = frame.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function apply() {
    const w = frame.clientWidth;
    const h = frame.clientHeight;
    tx = Math.min(0, Math.max(w * (1 - s), tx));
    ty = Math.min(0, Math.max(h * (1 - s), ty));
    content.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    frame.classList.toggle('is-zoomed', s > 1);
    onChange?.(s);
  }

  // Zoom to `next`, keeping the point (cx, cy) under the cursor / fingers fixed
  function zoomAt(cx, cy, next) {
    next = Math.min(maxScale, Math.max(1, next));
    if (next < 1.01) next = 1;
    const px = (cx - tx) / s;
    const py = (cy - ty) / s;
    s = next;
    tx = cx - px * s;
    ty = cy - py * s;
    apply();
  }

  // ---- Trackpad ----
  frame.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      // Pinch on a trackpad (also ctrl + mouse wheel)
      e.preventDefault();
      const [x, y] = local(e);
      zoomAt(x, y, s * Math.exp(-e.deltaY * 0.01));
    } else if (s > 1) {
      // Two-finger scroll pans the zoomed photo
      e.preventDefault();
      tx -= e.deltaX;
      ty -= e.deltaY;
      apply();
    }
  }, { passive: false });

  // Safari reports trackpad pinches as gesture events instead of ctrl+wheel
  let gestureStart = 1;
  frame.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStart = s; });
  frame.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(x, y, gestureStart * e.scale);
  });
  frame.addEventListener('gestureend', (e) => e.preventDefault());

  // ---- Mouse / touch ----
  const pinchInfo = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
  };

  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { frame.setPointerCapture(e.pointerId); } catch {} // keeps the drag going outside the photo
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      gesture = { type: 'drag', start: local(e), tx, ty, canSwipe: true };
    } else if (pointers.size === 2) {
      gesture = { type: 'pinch', ...pinchInfo() };
    }
  });

  frame.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (gesture?.type === 'pinch' && pointers.size >= 2) {
      const info = pinchInfo();
      tx += info.cx - gesture.cx; // follow the fingers as they move
      ty += info.cy - gesture.cy;
      zoomAt(info.cx, info.cy, s * (info.dist / gesture.dist));
      Object.assign(gesture, info);
    } else if (gesture?.type === 'drag' && s > 1) {
      const [x, y] = local(e);
      tx = gesture.tx + (x - gesture.start[0]);
      ty = gesture.ty + (y - gesture.start[1]);
      frame.classList.add('is-panning');
      apply();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    const [x, y] = local(e);
    pointers.delete(e.pointerId);

    if (gesture?.type === 'drag' && gesture.canSwipe && e.type === 'pointerup' && s === 1) {
      const dx = x - gesture.start[0];
      const dy = y - gesture.start[1];
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) onSwipe?.(dx < 0 ? 1 : -1);
    }

    if (pointers.size === 1) {
      // One finger lifted mid-pinch: carry on as a pan, but never as a swipe
      const [p] = [...pointers.values()];
      gesture = { type: 'drag', start: p, tx, ty, canSwipe: false };
    } else if (pointers.size === 0) {
      gesture = null;
      frame.classList.remove('is-panning');
    }
  }
  frame.addEventListener('pointerup', endPointer);
  frame.addEventListener('pointercancel', endPointer);

  return {
    reset() {
      s = 1;
      tx = 0;
      ty = 0;
      apply();
    },
    get scale() {
      return s;
    },
  };
}
