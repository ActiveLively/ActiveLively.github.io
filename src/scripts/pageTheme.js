// Turns a photo's colour palette into a page theme by overriding the
// colour variables in src/styles/global.css (everything on the site uses them).

const VARS = ['--bg-page', '--text-main', '--bg-nav-mobile', '--text-nav-link',
  '--bg-menu-btn', '--text-menu-btn', '--text-link-accent'];

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a, b, w) => a.map((v, i) => v + (b[i] - v) * w); // w = share of b

// WCAG relative luminance and contrast ratio
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const saturation = ([r, g, b]) => {
  const mx = Math.max(r, g, b);
  return mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx;
};

// palette: [{ hex, share }] as produced by the photo viewer
function themeFromPalette(palette) {
  const colours = palette.map((c) => ({ ...c, rgb: hexToRgb(c.hex) }));

  // Background: a pale tint of the photo's most characteristic colour
  const score = (c) => saturation(c.rgb) * Math.sqrt(c.share);
  const accent = colours.reduce((best, c) => (score(c) > score(best) ? c : best));
  const bg = mix(accent.rgb, [255, 255, 255], 0.84);

  // Text: the photo's darkest colour, darkened until it's comfortably readable
  let text = colours.reduce((best, c) => (luminance(c.rgb) < luminance(best.rgb) ? c : best)).rgb;
  for (let i = 0; i < 20 && contrast(text, bg) < 7; i++) text = mix(text, [0, 0, 0], 0.2);

  const bgHex = rgbToHex(bg);
  const textHex = rgbToHex(text);
  return {
    '--bg-page': bgHex,
    '--text-main': textHex,
    '--bg-nav-mobile': bgHex,
    '--text-nav-link': textHex,
    '--bg-menu-btn': textHex,
    '--text-menu-btn': bgHex,
    '--text-link-accent': textHex,
  };
}

let activeKey = null;
let fadeTimer = 0;

function withFade(fn) {
  const root = document.documentElement;
  root.classList.add('theme-fading');
  fn(root);
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => root.classList.remove('theme-fading'), 700);
}

// key identifies which photo the theme came from
export function applyPaletteTheme(palette, key) {
  if (!palette.length) return;
  const theme = themeFromPalette(palette);
  withFade((root) => {
    for (const [name, value] of Object.entries(theme)) root.style.setProperty(name, value);
  });
  activeKey = key;
}

export function resetPageTheme() {
  withFade((root) => VARS.forEach((name) => root.style.removeProperty(name)));
  activeKey = null;
}

export const activeThemeKey = () => activeKey;
