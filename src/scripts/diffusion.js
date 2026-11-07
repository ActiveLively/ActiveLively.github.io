// Diffusion effect for photos.
//
// Rendering follows the DDPM forward equation  x_t = √ᾱ·x₀ + √(1−ᾱ)·ε
// with a cosine ᾱ schedule, plus a blur that grows with t so the photo
// comes back coarse-to-fine, the way diffusion models resolve images.
//
// - DiffusionRenderer: draws one photo at any noise level t ∈ [0, 1]
// - initHoldToDiffuse: press and hold a photo to noise it, release to denoise

export const STEPS = 1000;  // shown as "t = …"
const HOLD_FORWARD = 1.6;   // seconds of holding to reach full noise
const REVERSE = 1.8;        // seconds to denoise from full noise
const CLICK_MAX_MS = 220;   // a press shorter than this counts as a click
const DRAG_CANCEL_PX = 10;  // moving further than this is a scroll, not a hold

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform vec2 uRes;
uniform float uAlphaBar;
uniform float uBlur;
uniform float uGrain;
uniform float uSeed;

// Hash without sine (Dave Hoskins)
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// Standard normal sample via Box-Muller
float gauss(vec2 cell, float k) {
  float u1 = max(hash13(vec3(cell, uSeed + k)), 1e-6);
  float u2 = hash13(vec3(cell + 17.0, uSeed + k + 101.0));
  return sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
}

vec3 blurred(vec2 uv) {
  if (uBlur < 0.5) return texture2D(uImage, uv).rgb;
  vec2 px = uBlur / uRes;
  vec3 c = vec3(0.0);
  // 16 taps on a golden-angle spiral
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float r = sqrt((fi + 0.5) / 16.0);
    float a = fi * 2.3999632;
    c += texture2D(uImage, uv + vec2(cos(a), sin(a)) * r * px).rgb;
  }
  return c / 16.0;
}

void main() {
  vec3 x0 = blurred(vUv) * 2.0 - 1.0;                 // image in [-1, 1]
  vec2 cell = floor(gl_FragCoord.xy / uGrain);
  vec3 eps = vec3(gauss(cell, 0.0), gauss(cell, 1.0), gauss(cell, 2.0));
  vec3 xt = sqrt(uAlphaBar) * x0 + sqrt(1.0 - uAlphaBar) * eps;
  gl_FragColor = vec4(clamp(xt * 0.5 + 0.5, 0.0, 1.0), 1.0);
}`;

// Cosine schedule (Nichol & Dhariwal): ᾱ(t) = cos²(((t + s) / (1 + s)) · π/2)
export function alphaBar(t) {
  const s = 0.008;
  const f = Math.cos(((t + s) / (1 + s)) * Math.PI * 0.5);
  return Math.max(0, Math.min(1, f * f));
}

// Owns a <canvas> + WebGL context. Call load(img) to place a photo in it
// (sized to how big the photo is on screen), then render(t) as often as needed.
export class DiffusionRenderer {
  constructor(className = 'diffusion-canvas') {
    this.canvas = document.createElement('canvas');
    this.canvas.className = className;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.source = document.createElement('canvas');
    this.img = null;
    this.seed = 0;
    this.ok = this.#setup();
  }

  #setup() {
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false });
    if (!gl) return false;
    this.gl = gl;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('Diffusion shader error:', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return false;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      res: gl.getUniformLocation(program, 'uRes'),
      alphaBar: gl.getUniformLocation(program, 'uAlphaBar'),
      blur: gl.getUniformLocation(program, 'uBlur'),
      grain: gl.getUniformLocation(program, 'uGrain'),
      seed: gl.getUniformLocation(program, 'uSeed'),
    };

    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    return true;
  }

  // Pixel size the canvas should have to match `img` as currently displayed.
  // The on-screen box includes any zoom, so a zoomed photo gets a sharper canvas,
  // capped so very deep zooms don't create huge textures.
  #targetSize(img) {
    const MAX_SIDE = 4096;
    const rect = img.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cap = Math.min(1, MAX_SIDE / Math.max(rect.width * dpr, rect.height * dpr, 1));
    return {
      w: Math.max(1, Math.round(rect.width * dpr * cap)),
      h: Math.max(1, Math.round(rect.height * dpr * cap)),
      dpr: dpr * cap, // keeps the noise grain about one screen pixel
    };
  }

  // True when load(img) would change nothing (same photo, same on-screen size).
  // Compares the src too: the viewer reuses one <img> and just swaps its src.
  isLoaded(img) {
    // (img.src, not currentSrc, which lags behind until the new src loads)
    if (this.img !== img || this.src !== img.src) return false;
    const { w, h } = this.#targetSize(img);
    return this.canvas.width === w && this.canvas.height === h;
  }

  // Upload `img`'s pixels. Returns false if it can't (not loaded yet, no CORS, no WebGL).
  load(img) {
    if (!this.ok || !img.complete || !img.naturalWidth) return false;
    const { w, h, dpr } = this.#targetSize(img);

    // Downscale through a 2D canvas: originals can exceed GPU texture limits
    this.source.width = w;
    this.source.height = h;
    this.source.getContext('2d').drawImage(img, 0, 0, w, h);
    const gl = this.gl;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
    } catch (err) {
      // Image was served without CORS headers, so its pixels can't be read
      console.warn('Diffusion effect unavailable for this image:', err);
      return false;
    }

    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(this.u.res, w, h);
    gl.uniform1f(this.u.grain, dpr);
    this.img = img;
    this.src = img.src;
    return true;
  }

  // Draw at noise level t (0 = clean, 1 = pure noise). Every call draws fresh noise.
  render(t) {
    const gl = this.gl;
    const minSide = Math.min(this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.alphaBar, alphaBar(t));
    gl.uniform1f(this.u.blur, minSide * 0.035 * Math.pow(t, 1.5));
    gl.uniform1f(this.u.seed, (this.seed++ % 997) + 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// Press and hold any of `images` to noise it in place; release to denoise.
// A quick click calls onClick(img) instead.
export function initHoldToDiffuse(images, { onClick } = {}) {
  if (!images.length) return;

  // One shared renderer, moved onto whichever photo is active
  let renderer = null;
  let badge = null;

  let active = null;  // the <img> currently showing the effect
  let t = 0;          // 0 = clean photo, 1 = pure noise
  let mode = 'idle';  // 'pending' | 'hold' | 'reverse' | 'idle'
  let press = null;   // { id, img, x, y, time } while a pointer is down
  let rafId = 0;
  let lastTime = 0;

  function attach(img) {
    if (active === img) return true;
    if (active) detach(); // only one photo diffuses at a time
    renderer ??= new DiffusionRenderer();
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'diffusion-badge';
      badge.setAttribute('aria-hidden', 'true');
    }
    if (!renderer.load(img)) return false;
    img.parentElement.append(renderer.canvas, badge);
    active = img;
    t = 0;
    return true;
  }

  function detach() {
    renderer?.canvas.remove();
    badge?.remove();
    active = null;
    t = 0;
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (mode === 'pending' && press && now - press.time >= CLICK_MAX_MS) {
      // Held long enough: this is a hold, not a click
      mode = attach(press.img) ? 'hold' : 'idle';
    }
    if (mode === 'hold') {
      t = Math.min(1, t + dt / HOLD_FORWARD);
    } else if (mode === 'reverse') {
      t -= dt / REVERSE;
      if (t <= 0) { detach(); mode = 'idle'; }
    }

    if (active) {
      renderer.render(t);
      badge.textContent = `t = ${Math.round(t * STEPS)}`;
    }
    if (mode === 'idle' && !active) { rafId = 0; return; }
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId) return;
    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  // Let go of the current press without it counting as a click
  function release() {
    press = null;
    mode = active ? 'reverse' : 'idle';
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    press = { id: e.pointerId, img: e.currentTarget, x: e.clientX, y: e.clientY, time: performance.now() };
    // Wait to see if it's a click or a hold. A photo that's mid-denoise freezes meanwhile.
    mode = 'pending';
    startLoop();
  }

  function onPointerMove(e) {
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_CANCEL_PX) release();
  }

  function onPointerUp(e) {
    if (!press || e.pointerId !== press.id) return;
    const { img } = press;
    const wasClick = mode === 'pending';
    release();
    if (wasClick) onClick?.(img);
  }

  function onPointerCancel(e) {
    if (press && e.pointerId === press.id) release();
  }

  images.forEach((img) => {
    img.draggable = false;
    img.addEventListener('pointerdown', onPointerDown);
    // Stop the long-press menu on touch devices so holding works
    img.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}
