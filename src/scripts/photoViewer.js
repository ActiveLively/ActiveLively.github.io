// Photo viewer dialog: a large copy of the photo, its camera settings, a colour
// palette (which can become the page theme), and a noise slider with reset.
// ‹ › buttons, arrow keys and swipes move through the album; a trackpad pinch
// zooms into the photo (see zoomPan.js).
// Markup lives in src/components/PhotoViewer.astro.

import { DiffusionRenderer, STEPS } from './diffusion.js';
import { applyPaletteTheme, resetPageTheme, activeThemeKey } from './pageTheme.js';
import { createZoomPan } from './zoomPan.js';

const FIELDS = [
  ['camera', 'Camera'],
  ['lens', 'Lens'],
  ['focalLength', 'Focal length'],
  ['aperture', 'Aperture'],
  ['shutter', 'Shutter'],
  ['iso', 'ISO'],
  ['exposureComp', 'Exposure comp.'],
  ['size', 'Size'],
];

const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

let els = null;
let renderer = null;
let zoom = null;         // zoom / pan controller for the photo
let t = 0;              // noise level shown, 0..1
let animCancel = null;
let album = [];          // carousel <img>s of the open album
let index = 0;
let palette = [];        // palette of the photo on screen
const paletteCache = new Map();

// Not currentSrc: that keeps the previous URL until a newly set src has loaded
const srcOf = (img) => img.src;

function setup() {
  const dialog = document.getElementById('photo-viewer');
  if (!dialog) return false;
  const q = (sel) => dialog.querySelector(sel);
  els = {
    dialog,
    frame: q('.pv-frame'),
    zoom: q('.pv-zoom'),
    img: q('.pv-img'),
    prev: q('.pv-prev'),
    next: q('.pv-next'),
    albumName: q('.pv-album-name'),
    count: q('.pv-count'),
    meta: q('.pv-meta'),
    palette: q('.pv-palette'),
    themeApply: q('.pv-theme-apply'),
    themeReset: q('.pv-theme-reset'),
    slider: q('.pv-slider'),
    readout: q('.pv-t'),
    reset: q('.pv-reset'),
  };
  renderer = new DiffusionRenderer('pv-canvas');

  els.slider.addEventListener('input', () => {
    stopAnim();
    setNoise(els.slider.valueAsNumber / STEPS);
  });
  els.reset.addEventListener('click', () => animateTo(0, 300 + 900 * t, easeOutCubic));
  els.prev.addEventListener('click', () => go(-1));
  els.next.addEventListener('click', () => go(1));

  els.themeApply.addEventListener('click', () => {
    applyPaletteTheme(palette, srcOf(els.img));
    updateThemeButtons();
  });
  els.themeReset.addEventListener('click', () => {
    resetPageTheme();
    updateThemeButtons();
  });

  // Arrow keys move between photos (except while the slider has focus: it uses them)
  dialog.addEventListener('keydown', (e) => {
    if (e.target === els.slider) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  });

  // Trackpad pinch to zoom, scroll / drag to pan, swipe (at 1×) to change photo
  let redrawTimer = 0;
  zoom = createZoomPan(els.frame, els.zoom, {
    onSwipe: go,
    onChange: () => {
      // Redraw the noise at the new magnification once zooming pauses, so it stays sharp
      if (t === 0) return;
      clearTimeout(redrawTimer);
      redrawTimer = setTimeout(() => t > 0 && setNoise(t), 120);
    },
  });

  dialog.addEventListener('close', () => {
    stopAnim();
    setNoise(0);
    zoom.reset();
  });
  // Keep the noise canvas matched to the photo if the window changes size
  window.addEventListener('resize', () => {
    if (dialog.open && t > 0) setNoise(t);
  });
  return true;
}

// ---------- Noise ----------

// Show the photo at noise level `value` (0 = clean, 1 = pure noise)
function setNoise(value) {
  t = Math.max(0, Math.min(1, value));
  const step = Math.round(t * STEPS);
  els.slider.value = String(step);
  els.slider.setAttribute('aria-valuetext', `step ${step} of ${STEPS}`);
  els.readout.textContent = `t = ${step}`;
  els.reset.disabled = step === 0;

  if (t === 0) {
    renderer.canvas.remove();
    return;
  }
  // A newly set src that hasn't finished loading can't be drawn yet
  if (!renderer.isLoaded(els.img) && !(els.img.complete && renderer.load(els.img))) {
    renderer.canvas.remove(); // never leave the previous photo's noise on screen
    return;
  }
  if (!renderer.canvas.isConnected) els.zoom.append(renderer.canvas);
  renderer.render(t);
}

// Animate the noise level to `target`. Resolves true when done, false if interrupted.
function animateTo(target, ms, ease) {
  stopAnim();
  const from = t;
  const start = performance.now();
  return new Promise((resolve) => {
    let id = 0;
    const step = (now) => {
      const p = Math.min(1, (now - start) / ms);
      setNoise(from + (target - from) * ease(p));
      if (p < 1) {
        id = requestAnimationFrame(step);
      } else {
        animCancel = null;
        resolve(true);
      }
    };
    id = requestAnimationFrame(step);
    animCancel = () => {
      cancelAnimationFrame(id);
      animCancel = null;
      resolve(false);
    };
  });
}

function stopAnim() {
  animCancel?.();
}

// ---------- Moving between photos ----------

// Switch straight to the next / previous photo, with noise and zoom reset
function go(delta) {
  if (album.length < 2) return;
  stopAnim(); // e.g. a Reset still easing out
  setNoise(0);
  zoom.reset();
  showPhoto(album[(index + delta + album.length) % album.length]);
}

// Fill the viewer with `img` (a carousel photo)
function showPhoto(img) {
  index = Math.max(0, album.indexOf(img));
  els.img.src = srcOf(img);
  els.img.alt = img.alt;
  els.albumName.textContent = img.dataset.album || '';
  els.count.textContent = album.length > 1 ? `${index + 1} / ${album.length}` : '';

  let meta = {};
  try { meta = JSON.parse(img.dataset.meta || '{}'); } catch {}
  renderMeta(meta);

  palette = [];
  updateThemeButtons();
  if (img.complete && img.naturalWidth) showPalette(img);
  else img.addEventListener('load', () => showPalette(img), { once: true });

  revealInCarousel(img);
}

// Scroll the carousel behind the dialog so it ends on the photo you were viewing
function revealInCarousel(img) {
  const track = img.closest('.carousel');
  const item = img.closest('.carousel-item');
  if (!track || !item) return;
  const tr = track.getBoundingClientRect();
  const ir = item.getBoundingClientRect();
  track.scrollLeft += ir.left - tr.left - (tr.width - ir.width) / 2;
}

// ---------- Camera settings ----------

function renderMeta(meta) {
  els.meta.replaceChildren();
  const rows = FIELDS.filter(([key]) => meta[key]);
  for (const [key, label] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = meta[key];
    els.meta.append(dt, dd);
  }
  if (!rows.some(([key]) => key !== 'size')) {
    const note = document.createElement('p');
    note.className = 'pv-empty';
    note.textContent = 'No camera settings saved for this photo.';
    els.meta.append(note);
  }
}

// ---------- Colour palette (k-means on a small copy of the photo) ----------

const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function extractPalette(img, k = 6) {
  const scale = 64 / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return []; // no CORS access to the pixels
  }

  const px = [];
  for (let i = 0; i < data.length; i += 4) px.push([data[i], data[i + 1], data[i + 2]]);
  if (!px.length) return [];

  // Start centres spread across the brightness range so results are stable
  const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const sorted = [...px].sort((a, b) => lum(a) - lum(b));
  let centres = Array.from({ length: k }, (_, i) => [...sorted[Math.floor(((i + 0.5) / k) * sorted.length)]]);
  const assign = new Array(px.length).fill(0);

  for (let iter = 0; iter < 10; iter++) {
    for (let i = 0; i < px.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = (px[i][0] - centres[c][0]) ** 2 + (px[i][1] - centres[c][1]) ** 2 + (px[i][2] - centres[c][2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      const s = sums[assign[i]];
      s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
    }
    centres = sums.map((s, c) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centres[c]));
  }

  const counts = centres.map(() => 0);
  assign.forEach((c) => counts[c]++);
  return centres
    .map((c, i) => ({ hex: toHex(c), share: counts[i] / px.length }))
    .filter((c) => c.share > 0)
    .sort((a, b) => b.share - a.share);
}

function renderPalette(colours) {
  els.palette.replaceChildren();
  if (!colours.length) {
    const li = document.createElement('li');
    li.className = 'pv-empty';
    li.textContent = 'Palette unavailable.';
    els.palette.append(li);
    return;
  }
  for (const { hex, share } of colours) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pv-swatch';
    btn.title = `Copy ${hex}`;
    btn.innerHTML = `<span class="pv-chip"></span><span class="pv-hex"></span><span class="pv-share"></span>`;
    btn.querySelector('.pv-chip').style.background = hex;
    btn.querySelector('.pv-hex').textContent = hex;
    btn.querySelector('.pv-share').textContent = `${Math.round(share * 100)}%`;
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(hex).then(() => {
        const label = btn.querySelector('.pv-hex');
        label.textContent = 'copied';
        setTimeout(() => (label.textContent = hex), 1000);
      }).catch(() => {});
    });
    li.append(btn);
    els.palette.append(li);
  }
}

function showPalette(img) {
  const key = srcOf(img);
  if (!paletteCache.has(key)) paletteCache.set(key, extractPalette(img));
  // The user may have moved on to another photo while this one loaded
  if (srcOf(els.img) !== key) return;
  palette = paletteCache.get(key);
  renderPalette(palette);
  updateThemeButtons();
}

function updateThemeButtons() {
  const active = activeThemeKey();
  const isThisPhoto = active !== null && active === srcOf(els.img);
  els.themeApply.disabled = !palette.length || isThisPhoto;
  els.themeApply.textContent = isThisPhoto ? 'Page theme applied' : 'Use as page theme';
  els.themeReset.hidden = active === null;
}

// ---------- Public ----------

export function openPhotoViewer(img) {
  if (!els && !setup()) return;
  stopAnim();
  setNoise(0);
  zoom.reset();

  const track = img.closest('.carousel');
  album = track ? [...track.querySelectorAll('img.diffusable')] : [img];
  els.prev.hidden = els.next.hidden = album.length < 2;

  showPhoto(img);
  els.dialog.showModal();
}
