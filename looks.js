// Procedural film looks -> 3D LUTs (size^3), plus .cube import.
const LUT_SIZE = 33;
const clamp01 = v => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;

// Each look: contrast, sat, gamma, lift/gain per channel, split-tone, fade, bw, warmth
const LOOKS = [
  { id: 'natural',   name: 'Natural',      g: {} },
  { id: 'gold',      name: 'Gold 200',     g: { c: 1.08, s: 1.12, gain: [1.06, 1.0, 0.9], lift: [0.012, 0.006, 0], sh: [0.02, 0.0, -0.02], hi: [0.05, 0.03, -0.04], fade: 0.02 } },
  { id: 'portra',    name: 'Portra 400',   g: { c: 0.96, s: 0.92, gain: [1.03, 1.0, 0.96], lift: [0.02, 0.015, 0.012], sh: [0.0, 0.02, 0.01], hi: [0.04, 0.02, -0.01], fade: 0.035, gamma: 0.95 } },
  { id: 'velvia',    name: 'Velvia 50',    g: { c: 1.22, s: 1.45, gain: [1.02, 1.02, 1.0], sh: [-0.01, 0.0, 0.03], hi: [0.02, 0.0, -0.02] } },
  { id: 'ektar',     name: 'Ektar 100',    g: { c: 1.16, s: 1.3, gain: [1.05, 1.0, 0.95], hi: [0.03, 0.0, -0.03], sh: [0, 0.01, 0.02] } },
  { id: 'cine800',   name: 'Cine 800T',    g: { c: 1.1, s: 1.05, gain: [0.94, 1.02, 1.12], lift: [0, 0.01, 0.03], sh: [-0.03, 0.02, 0.07], hi: [0.07, -0.01, -0.05], fade: 0.02 } },
  { id: 'kodachrome',name: 'Kodachrome',   g: { c: 1.2, s: 1.2, gain: [1.08, 0.98, 0.94], sh: [0.03, -0.01, -0.02], hi: [0.05, 0.01, -0.05], gamma: 1.04 } },
  { id: 'superia',   name: 'Superia 400',  g: { c: 1.1, s: 1.15, gain: [0.97, 1.05, 1.0], sh: [-0.01, 0.03, 0.03], hi: [0.02, 0.02, -0.03], fade: 0.025 } },
  { id: 'teal',      name: 'Teal & Orange',g: { c: 1.15, s: 1.1, sh: [-0.07, 0.02, 0.08], hi: [0.09, 0.025, -0.08] } },
  { id: 'moody',     name: 'Moody',        g: { c: 1.28, s: 0.82, gamma: 1.14, gain: [0.97, 1.0, 1.04], sh: [-0.02, 0.01, 0.04], hi: [0.02, 0.0, -0.02], fade: 0.03 } },
  { id: 'bleach',    name: 'Bleach Bypass',g: { c: 1.38, s: 0.5, gamma: 1.05, hi: [0.0, 0.0, 0.01] } },
  { id: 'matte',     name: 'Matte',        g: { c: 0.9, s: 0.9, fade: 0.1, lift: [0.01, 0.01, 0.015], sh: [0.0, 0.01, 0.03], hi: [0.03, 0.01, 0.0] } },
  { id: 'golden',    name: 'Golden Hour',  g: { c: 1.06, s: 1.1, gain: [1.12, 1.02, 0.84], lift: [0.015, 0.005, 0], hi: [0.07, 0.03, -0.06] } },
  { id: 'arctic',    name: 'Arctic',       g: { c: 1.05, s: 0.85, gain: [0.9, 1.0, 1.12], hi: [-0.02, 0.01, 0.05], sh: [-0.02, 0.0, 0.05] } },
  { id: 'neon',      name: 'Neon Night',   g: { c: 1.25, s: 1.35, gamma: 1.1, sh: [0.06, -0.04, 0.12], hi: [0.05, 0.05, 0.0], gain: [1.02, 0.96, 1.06] } },
  { id: 'polaroid',  name: 'Polaroid',     g: { c: 0.92, s: 0.95, fade: 0.08, gain: [1.02, 1.0, 0.92], lift: [0.02, 0.025, 0.01], sh: [0.02, 0.04, 0.02], hi: [0.05, 0.02, -0.04] } },
  { id: 'vintage',   name: 'Vintage Fade', g: { c: 0.95, s: 0.75, fade: 0.14, gain: [1.05, 1.0, 0.88], sh: [0.04, 0.02, -0.01], hi: [0.04, 0.02, -0.03] } },
  { id: 'sepia',     name: 'Sepia',        g: { c: 1.05, bw: 1, tint: [1.12, 0.98, 0.78], fade: 0.03 } },
  { id: 'trix',      name: 'Tri-X B&W',    g: { c: 1.32, bw: 1, gamma: 1.05, fade: 0.01 } },
  { id: 'noir',      name: 'Noir',         g: { c: 1.55, bw: 1, gamma: 1.22, tint: [0.97, 1.0, 1.04] } },
  { id: 'silver',    name: 'Soft Silver',  g: { c: 0.9, bw: 1, fade: 0.09, gamma: 0.95, tint: [0.98, 1.0, 1.03] } },
];

function gradePixel(r, g, b, p) {
  const gain = p.gain || [1, 1, 1], lift = p.lift || [0, 0, 0];
  const sh = p.sh || [0, 0, 0], hi = p.hi || [0, 0, 0];
  const c = p.c ?? 1, s = p.s ?? 1, gam = p.gamma ?? 1, fade = p.fade ?? 0;
  let x = [r, g, b];
  for (let i = 0; i < 3; i++) x[i] = clamp01(x[i] * gain[i] + lift[i]);
  for (let i = 0; i < 3; i++) x[i] = Math.pow(x[i], gam);
  // filmic-ish S curve around 0.5
  for (let i = 0; i < 3; i++) {
    const v = x[i];
    const sc = v < 0.5 ? 0.5 * Math.pow(2 * v, c) : 1 - 0.5 * Math.pow(2 * (1 - v), c);
    x[i] = sc;
  }
  let l = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
  for (let i = 0; i < 3; i++) x[i] = mix(l, x[i], s);
  const ws = (1 - l) * (1 - l), wh = l * l;
  for (let i = 0; i < 3; i++) x[i] += sh[i] * ws + hi[i] * wh;
  if (p.bw) {
    l = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
    const t = p.tint || [1, 1, 1];
    x = [l * t[0], l * t[1], l * t[2]];
  }
  for (let i = 0; i < 3; i++) x[i] = clamp01(fade + x[i] * (1 - fade));
  return x;
}

function buildLut(look, size = LUT_SIZE) {
  const data = new Uint8Array(size * size * size * 4);
  const n = size - 1;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = ((b * size + g) * size + r) * 4;
    const x = gradePixel(r / n, g / n, b / n, look.g);
    data[o] = Math.round(x[0] * 255); data[o + 1] = Math.round(x[1] * 255); data[o + 2] = Math.round(x[2] * 255); data[o + 3] = 255;
  }
  return { size, data };
}

// Parse an Adobe/Resolve .cube 3D LUT into { size, data(RGBA bytes) }
function parseCube(text) {
  let size = 0, dmin = [0, 0, 0], dmax = [1, 1, 1], vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
    else if (parts[0] === 'DOMAIN_MIN') dmin = parts.slice(1, 4).map(Number);
    else if (parts[0] === 'DOMAIN_MAX') dmax = parts.slice(1, 4).map(Number);
    else if (/^[-+\d.]/.test(parts[0]) && parts.length >= 3) vals.push(parts.slice(0, 3).map(Number));
  }
  if (!size || vals.length !== size * size * size) throw new Error('Not a valid 3D .cube LUT');
  const data = new Uint8Array(size * size * size * 4);
  vals.forEach((v, i) => {
    for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round(clamp01((v[k] - dmin[k]) / (dmax[k] - dmin[k])) * 255);
    data[i * 4 + 3] = 255;
  });
  return { size, data };
}

// Nearest-sample a LUT on the CPU (for swatches)
function lutSample(lut, r, g, b) {
  const n = lut.size - 1;
  const ri = Math.round(r * n), gi = Math.round(g * n), bi = Math.round(b * n);
  const o = ((bi * lut.size + gi) * lut.size + ri) * 4;
  return [lut.data[o], lut.data[o + 1], lut.data[o + 2]];
}

// A small gradient swatch showing what the look does to skin / sky / foliage / shadow
function swatchGradient(lut) {
  const probes = [[0.86, 0.66, 0.54], [0.45, 0.65, 0.92], [0.35, 0.65, 0.3], [0.9, 0.85, 0.7], [0.12, 0.1, 0.16]];
  const stops = probes.map(p => { const c = lutSample(lut, ...p); return `rgb(${c[0]},${c[1]},${c[2]})`; });
  return `conic-gradient(from 200deg, ${stops.join(',')}, ${stops[0]})`;
}
