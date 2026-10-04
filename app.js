'use strict';
const $ = s => document.querySelector(s);
const app = $('#app'), view = $('#view'), video = document.createElement('video');
video.playsInline = true; video.muted = true; video.setAttribute('playsinline', '');

/* ---------- settings ---------- */
const ASPECTS = [['3:4', 3 / 4], ['9:16', 9 / 16], ['1:1', 1]];
const TIMERS = [0, 3, 10];
const MODES = [
  { id: 'timelapse', name: 'Time-Lapse', kind: 'video', cls: 'video', asp: 1 },
  { id: 'slomo', name: 'Slo-Mo', kind: 'video', cls: 'slomo', asp: 1 },
  { id: 'video', name: 'Video', kind: 'video', cls: 'video', asp: 1 },
  { id: 'cinematic', name: 'Cinematic', kind: 'video', cls: 'video', asp: 1, fx: true },
  { id: 'photo', name: 'Photo', kind: 'photo', cls: 'photo', asp: 0 },
  { id: 'portrait', name: 'Portrait', kind: 'photo', cls: 'photo', asp: 0, fx: true },
  { id: 'pano', name: 'Pano', kind: 'photo', cls: 'photo', asp: 0 },
];
const S = Object.assign({ mode: 'photo', look: 'gold', aspect: 0, timer: 0, grid: false, facing: 'environment', int: 100, exp: 0, grain: 18, vig: 22,
  blur: 60, light: 0, tl: 1, sm: 4, stamp: 0, q: 0.95, looksOpen: true },
  (() => { try { return JSON.parse(localStorage.getItem('luma') || '{}'); } catch { return {}; } })());
const save = () => { try { localStorage.setItem('luma', JSON.stringify(S)); } catch {} };
const mode = () => MODES.find(m => m.id === S.mode) || MODES[4];
const wait = ms => new Promise(r => setTimeout(r, ms));

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400); }
function busyShow(msg) { $('#busyMsg').textContent = msg; $('#busy').classList.add('on'); }
function busyHide() { $('#busy').classList.remove('on'); }

/* ---------- IndexedDB ---------- */
const db = new Promise((res, rej) => {
  const r = indexedDB.open('luma', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true }); r.result.createObjectStore('luts', { keyPath: 'id' }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (store, m, fn) => { const d = await db; return new Promise((res, rej) => { const t = d.transaction(store, m); const rq = fn(t.objectStore(store)); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); }); };

/* ---------- looks ---------- */
const luts = {}, allLooks = [];
for (const l of LOOKS) { luts[l.id] = buildLut(l); allLooks.push({ id: l.id, name: l.name }); }
async function loadCustomLuts() {
  const rows = await tx('luts', 'readonly', s => s.getAll()).catch(() => []);
  for (const r of rows || []) { try { luts[r.id] = parseCube(r.text); if (!allLooks.find(a => a.id === r.id)) allLooks.push({ id: r.id, name: r.name, custom: true }); } catch {} }
}
function renderLooks() {
  const box = $('#looks'); box.innerHTML = '';
  for (const l of allLooks) {
    const el = document.createElement('button'); el.className = 'look'; el.dataset.id = l.id;
    el.innerHTML = `<div class="sw" style="background:${swatchGradient(luts[l.id])}"></div><span>${l.name}</span>`;
    el.onclick = () => selectLook(l.id);
    box.appendChild(el);
  }
  markLook(false);
}
function markLook(scroll = true) {
  document.querySelectorAll('.look').forEach(e => e.classList.toggle('on', e.dataset.id === S.look));
  const cur = allLooks.find(l => l.id === S.look) || allLooks[0];
  $('#lookName').textContent = cur.name; updateHud();
  const el = document.querySelector('.look.on');
  if (el) { if (scroll) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); else $('#looks').scrollLeft = el.offsetLeft - $('#looks').clientWidth / 2 + 28; }
}
function selectLook(id) { S.look = id; save(); useLut(id); markLook(); }
function updateHud() { const cur = allLooks.find(l => l.id === S.look) || allLooks[0]; $('#hud').textContent = `${mode().name} · ${cur.name}`; }

/* ---------- WebGL ---------- */
const gl = view.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
const VS = `attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}`;
const FS = `precision highp float;varying vec2 uv;
uniform sampler2D uVid,uLut,uMask;
uniform float uSize,uInt,uExp,uGrain,uVig,uTime,uZoom,uFlip,uFx,uBlur,uRack,uLight,uAspect;
uniform vec2 uScale,uFocus;
float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec2 src(vec2 u){vec2 q=(u-.5)*uScale/uZoom;q.x*=uFlip;return q+.5;}
vec3 lut(vec3 c){float s=uSize;c=clamp(c,0.,1.);float b=c.b*(s-1.);float b0=floor(b);float b1=min(b0+1.,s-1.);float f=b-b0;
 float x=c.r*(s-1.)+.5;float y=(c.g*(s-1.)+.5)/s;
 vec3 a=texture2D(uLut,vec2((b0*s+x)/(s*s),y)).rgb;vec3 d=texture2D(uLut,vec2((b1*s+x)/(s*s),y)).rgb;return mix(a,d,f);}
float subj(vec2 u){
 if(uFx>1.5){vec2 d=(u-uFocus)*vec2(uAspect,1.);return 1.-smoothstep(.12,.42,length(d));}
 return smoothstep(.25,.75,texture2D(uMask,src(u)).r);}
float bgw(vec2 u){float m=subj(u);return mix(1.-m,m,uRack);}
void main(){
 vec3 c=texture2D(uVid,src(uv)).rgb;
 float m=1.;
 if(uFx>.5){
  m=subj(uv);float bw=mix(1.-m,m,uRack);
  float R=uBlur*bw;
  if(R>.0008){
   vec3 acc=c;float ws=1.;
   for(int i=0;i<28;i++){float fi=float(i);float r=sqrt((fi+.5)/28.)*R;float a=fi*2.39996;
    vec2 o=vec2(cos(a)/uAspect,sin(a))*r;vec2 u2=uv+o;
    vec3 s=texture2D(uVid,src(u2)).rgb;
    float w=(.15+bgw(u2))*(1.+pow(dot(s,vec3(.33)),4.)*3.);
    acc+=s*w;ws+=w;}
   c=mix(c,acc/ws,clamp(bw*4.,0.,1.));
  }
  float l0=dot(c,vec3(.2126,.7152,.0722));
  if(uLight>.5&&uLight<1.5){c=mix(c*.78,c*1.16+.02,m);}
  else if(uLight>1.5&&uLight<2.5){c*=mix(.0,1.05,m);}
  else if(uLight>2.5&&uLight<3.5){c=vec3(l0*mix(.0,1.1,m));}
  else if(uLight>3.5){c=mix(vec3(1.),vec3(l0*1.12+.04),m);}
 }
 c*=pow(2.,uExp);
 vec3 g=lut(c);c=mix(c,g,uInt);
 float l=dot(c,vec3(.2126,.7152,.0722));
 float n=(h(uv*vec2(1731.,1297.)+uTime)+h(uv*vec2(913.,1117.)-uTime)-1.)*uGrain*(.35+.65*(1.-abs(l-.5)*1.4));
 c+=n;
 float v=smoothstep(.95,.25,distance(uv,vec2(.5))*1.25);c*=mix(1.,v,uVig);
 gl_FragColor=vec4(clamp(c,0.,1.),1.);}`;
function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const U = {}; for (const n of ['uVid', 'uLut', 'uMask', 'uSize', 'uInt', 'uExp', 'uGrain', 'uVig', 'uTime', 'uZoom', 'uFlip', 'uFx', 'uBlur', 'uRack', 'uLight', 'uAspect', 'uScale', 'uFocus']) U[n] = gl.getUniformLocation(prog, n);
function mkTex() { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; }
const vidTex = mkTex(), lutTex = mkTex(), maskTex = mkTex(); let lutSize = LUT_SIZE;
gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([255]));
function stripFromCube(l) {
  const s = l.size, out = new Uint8Array(s * s * s * 4);
  for (let b = 0; b < s; b++) for (let g = 0; g < s; g++) for (let r = 0; r < s; r++) {
    const a = ((b * s + g) * s + r) * 4, d = (g * s * s + b * s + r) * 4;
    out[d] = l.data[a]; out[d + 1] = l.data[a + 1]; out[d + 2] = l.data[a + 2]; out[d + 3] = 255;
  } return out;
}
function useLut(id) {
  const l = luts[id] || luts.natural; lutSize = l.size;
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutTex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, l.size * l.size, l.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, stripFromCube(l));
}

/* ---------- portrait / subject segmentation (MediaPipe, bundled, runs on-device) ---------- */
let seg = null, segState = 'idle', maskArr = null, maskW = 0, maskH = 0, lastSeg = 0;
const segCanvas = document.createElement('canvas'), segCtx = segCanvas.getContext('2d', { willReadFrequently: true });
async function loadSeg() {
  if (segState !== 'idle') return; segState = 'loading';
  toast('Loading portrait engine…');
  try {
    const { FilesetResolver, ImageSegmenter } = await import('./vendor/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks('./vendor/wasm');
    seg = await ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: './vendor/selfie_segmenter.tflite', delegate: 'CPU' }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
    segState = 'ready'; toast('Portrait engine ready');
  } catch (e) { console.warn(e); segState = 'failed'; toast('Using soft-focus portrait'); }
}
function runSeg(now) {
  if (segState !== 'ready' || now - lastSeg < 50 || !video.videoWidth) return; lastSeg = now;
  const sa = video.videoWidth / video.videoHeight, w = 256, h = Math.max(64, Math.round(256 / sa));
  if (segCanvas.width !== w || segCanvas.height !== h) { segCanvas.width = w; segCanvas.height = h; }
  segCtx.drawImage(video, 0, 0, w, h);
  let r; try { r = seg.segmentForVideo(segCanvas, now); } catch { return; }
  const m = r.confidenceMasks && r.confidenceMasks[0]; if (!m) { r.close && r.close(); return; }
  const f = m.getAsFloat32Array(); maskW = m.width; maskH = m.height;
  if (!maskArr || maskArr.length !== f.length) maskArr = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) maskArr[i] = (maskArr[i] + f[i] * 255) >> 1;  // temporal smoothing
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, maskW, maskH, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, maskArr);
  r.close && r.close();
}

/* ---------- render ---------- */
let zoom = 1, mirror = false, rack = 0, rackTarget = 0, focusUV = [0.5, 0.5];
const fxOn = () => !!mode().fx;
function draw(w, h, forSave) {
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  gl.viewport(0, 0, w, h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vidTex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  const A = w / h, sa = video.videoWidth / video.videoHeight;
  gl.uniform1i(U.uVid, 0); gl.uniform1i(U.uLut, 1); gl.uniform1i(U.uMask, 2); gl.uniform1f(U.uSize, lutSize);
  gl.uniform1f(U.uInt, S.int / 100); gl.uniform1f(U.uExp, S.exp / 50); gl.uniform1f(U.uGrain, S.grain / 100 * 0.16);
  gl.uniform1f(U.uVig, S.vig / 100 * 0.8); gl.uniform1f(U.uTime, (performance.now() % 1000) / 1000 * 7.3);
  gl.uniform1f(U.uZoom, zoom); gl.uniform2f(U.uScale, sa > A ? A / sa : 1, sa > A ? 1 : sa / A);
  gl.uniform1f(U.uFlip, (mirror && !forSave) ? -1 : 1);
  const fx = fxOn() ? (segState === 'ready' && maskArr ? 1 : 2) : 0;
  gl.uniform1f(U.uFx, fx); gl.uniform1f(U.uBlur, S.blur / 100 * 0.045); gl.uniform1f(U.uRack, rack);
  gl.uniform1f(U.uLight, S.light); gl.uniform1f(U.uAspect, A); gl.uniform2f(U.uFocus, focusUV[0], focusUV[1]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
let recL = 1400;
function previewSize() { const A = ASPECTS[S.aspect][1], L = recL; return A <= 1 ? [Math.round(L * A), L] : [L, Math.round(L / A)]; }

const glow = $('#glow'), glowCtx = glow.getContext('2d');
let frameN = 0, newCamFrame = false;
function watchFrames() { if (video.requestVideoFrameCallback) { const cb = () => { newCamFrame = true; video.requestVideoFrameCallback(cb); }; video.requestVideoFrameCallback(cb); } }

function loop(now) {
  requestAnimationFrame(loop);
  if (loop.pause || video.readyState < 2 || !video.videoWidth) return;
  if (fxOn()) { runSeg(now); rack += (rackTarget - rack) * 0.14; }
  const [w, h] = previewSize(); draw(w, h, false);
  if ((frameN++ & 7) === 0) glowCtx.drawImage(view, 0, 0, glow.width, glow.height);
  if (rec) recTick(now);
  if (pano) panoTick();
}

/* ---------- camera ---------- */
let stream = null, lenses = [], curLens = 1, camClass = null;
function constraintsFor(cls) {
  if (cls === 'slomo') return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 120 } };
  if (cls === 'video') return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  return { width: { ideal: 4032 }, height: { ideal: 3024 } };
}
async function startCamera(opts = {}) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  camClass = mode().cls;
  const v = constraintsFor(camClass);
  if (opts.deviceId) v.deviceId = { exact: opts.deviceId }; else v.facingMode = { ideal: S.facing };
  stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
  video.srcObject = stream; await video.play(); watchFrames();
  const st = stream.getVideoTracks()[0].getSettings();
  mirror = st.facingMode ? st.facingMode === 'user' : (S.facing === 'user' && !opts.deviceId);
  startCamera.fps = st.frameRate || 30;
}
async function buildLenses() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const find = re => devs.find(d => re.test(d.label));
  const back = find(/back camera$/i) || find(/back(?!.*(ultra|tele))/i), ultra = find(/ultra/i), tele = find(/tele/i);
  lenses = [];
  if (S.facing === 'environment') {
    if (ultra) lenses.push({ t: '.5', id: ultra.deviceId, z: 1 });
    lenses.push({ t: '1×', id: back && back.deviceId, z: 1 }, { t: '2×', id: back && back.deviceId, z: 2 });
    if (tele) lenses.push({ t: 'Tele', id: tele.deviceId, z: 1 });
  } else lenses = [{ t: '1×', id: null, z: 1 }, { t: '2×', id: null, z: 2 }];
  curLens = Math.max(0, lenses.findIndex(l => l.t === '1×'));
  const row = $('#lensRow'); row.innerHTML = '';
  lenses.forEach((l, i) => { const b = document.createElement('button'); b.textContent = l.t; b.onclick = () => setLens(i); b.className = i === curLens ? 'on' : ''; row.appendChild(b); });
}
async function setLens(i) {
  const l = lenses[i], prev = lenses[curLens]; curLens = i;
  document.querySelectorAll('#lensRow button').forEach((b, k) => b.classList.toggle('on', k === i));
  if (l.id !== prev.id && l.id) { try { await startCamera({ deviceId: l.id }); } catch { toast('Lens unavailable'); } }
  zoom = l.z;
}
let pd = 0, pz = 1;
$('#frame').addEventListener('touchstart', e => { if (e.touches.length === 2) { pd = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY); pz = zoom; } }, { passive: true });
$('#frame').addEventListener('touchmove', e => { if (e.touches.length === 2 && pd) { const d = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY); zoom = Math.min(8, Math.max(1, pz * d / pd)); document.querySelectorAll('#lensRow button').forEach(b => b.classList.remove('on')); } }, { passive: true });
$('#frame').addEventListener('touchend', () => { pd = 0; });

// tap to focus: moves the focus point and (in Portrait/Cinematic) racks focus subject <-> background
$('#frame').addEventListener('click', e => {
  if (e.target.closest('#lensRow')) return;
  const r = $('#frame').getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const ring = $('#focusRing'); ring.style.left = x * 100 + '%'; ring.style.top = y * 100 + '%'; ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
  focusUV = [x, 1 - y];
  if (fxOn() && maskArr) {
    const A = r.width / r.height, sa = video.videoWidth / video.videoHeight;
    const sx = sa > A ? A / sa : 1, sy = sa > A ? 1 : sa / A;
    let qx = (x - .5) * sx / zoom, qy = (.5 - y) * sy / zoom; if (mirror) qx = -qx;
    const px = Math.min(maskW - 1, Math.max(0, Math.floor((qx + .5) * maskW))), py = Math.min(maskH - 1, Math.max(0, Math.floor((.5 - qy) * maskH)));
    rackTarget = maskArr[py * maskW + px] > 128 ? 0 : 1;
  }
});

/* ---------- helpers: output canvas, stamp, file saving ---------- */
function stampText(ctx, w, h) {
  const d = new Date(), t = `'${String(d.getFullYear()).slice(2)}  ${d.getMonth() + 1}  ${d.getDate()}`;
  const fs = Math.round(Math.min(w, h) * 0.034);
  ctx.font = `700 ${fs}px "Courier New",monospace`; ctx.textAlign = 'right'; ctx.fillStyle = '#ff8a1e'; ctx.shadowColor = 'rgba(255,120,0,.85)'; ctx.shadowBlur = fs * 0.5;
  ctx.fillText(t, w - fs * 1.2, h - fs * 1.1); ctx.shadowBlur = 0;
}
const jpeg = (cv, q) => new Promise(r => cv.toBlob(r, 'image/jpeg', q));
async function store(rec_) { await tx('photos', 'readwrite', s => s.add(rec_)); updateThumb(); }
const lookName = () => (allLooks.find(l => l.id === S.look) || {}).name || '';
function flashAnim() { const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
let wakeLock = null;
async function lock(on) { try { if (on) wakeLock = await navigator.wakeLock.request('screen'); else if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch {} }

/* ---------- photo / portrait ---------- */
async function shootPhoto() {
  const A = ASPECTS[S.aspect][1], sa = video.videoWidth / video.videoHeight;
  let h = Math.min(video.videoHeight, 4096), w = Math.round(h * A);
  if (sa < A) { w = Math.min(video.videoWidth, 4096); h = Math.round(w / A); }
  loop.pause = true; draw(w, h, true);
  let blob;
  if (S.stamp) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(view, 0, 0); stampText(x, w, h); blob = await jpeg(c, S.q); }
  else blob = await jpeg(view, S.q);
  loop.pause = false; flashAnim();
  if (blob) await store({ kind: 'photo', blob, look: `${mode().name} · ${lookName()}`, ts: Date.now(), w, h });
}

/* ---------- video / cinematic / time-lapse / slo-mo ---------- */
let rec = null; // {type, canvas, ctx, ...}
const recCanvas = document.createElement('canvas'), recCtx = recCanvas.getContext('2d');
function pickMime() { for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; return ''; }
let micTrack = null;
async function getMic() { if (micTrack && micTrack.readyState === 'live') return micTrack; try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); micTrack = s.getAudioTracks()[0]; } catch { toast('Mic blocked — recording without sound'); } return micTrack; }
function startRecorder(canvas, audio) {
  const cs = canvas.captureStream(30); if (audio) cs.addTrack(audio);
  const mime = pickMime(), chunks = [];
  const mr = new MediaRecorder(cs, mime ? { mimeType: mime, videoBitsPerSecond: 14e6 } : { videoBitsPerSecond: 14e6 });
  mr.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
  const done = new Promise(r => { mr.onstop = () => r(new Blob(chunks, { type: mr.mimeType || mime || 'video/mp4' })); });
  mr.start(250); return { mr, done };
}
function fmt(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

async function startRec() {
  const m = mode(); recL = m.cls === 'slomo' ? 1280 : 1920;
  const [w, h] = previewSize(); draw(w, h, false);
  recCanvas.width = view.width; recCanvas.height = view.height;
  rec = { type: m.id, t0: performance.now(), frames: [], times: [], pending: 0, lastTl: 0 };
  if (m.id === 'video' || m.id === 'cinematic') {
    const mic = await getMic(); const r = startRecorder(recCanvas, mic); rec.mr = r.mr; rec.done = r.done;
  }
  app.classList.add('rec'); $('#shutter').classList.add('rec'); lock(true); $('#recTime').textContent = '00:00';
  if (m.id === 'timelapse') $('#recTime').textContent = '0 frames';
}
function recTick(now) {
  if (rec.stopping && !rec.mr) return;
  recCtx.drawImage(view, 0, 0);
  if (S.stamp) stampText(recCtx, recCanvas.width, recCanvas.height);
  const el = now - rec.t0;
  if (rec.type === 'video' || rec.type === 'cinematic') $('#recTime').textContent = fmt(el);
  else if (rec.type === 'timelapse') {
    if (now - rec.lastTl >= S.tl * 1000) { rec.lastTl = now; const i = rec.frames.length; rec.frames.push(null); rec.pending++; recCanvas.toBlob(b => { rec.frames[i] = b; rec.pending--; }, 'image/jpeg', 0.88); $('#recTime').textContent = `${i + 1} frames · ${fmt(el)}`; }
  } else if (rec.type === 'slomo') {
    if (newCamFrame || !video.requestVideoFrameCallback) { newCamFrame = false; const i = rec.frames.length; rec.frames.push(null); rec.times.push(now); rec.pending++; recCanvas.toBlob(b => { rec.frames[i] = b; rec.pending--; }, 'image/jpeg', 0.82); }
    $('#recTime').textContent = fmt(el);
    if (el > 8000) stopRec();
  }
}
async function stopRec() {
  const r = rec; if (!r || r.stopping) return; r.stopping = true;
  app.classList.remove('rec'); $('#shutter').classList.remove('rec'); lock(false);
  const posterCanvas = recCanvas; let blob, poster = await jpeg(posterCanvas, 0.7); const w = recCanvas.width, h = recCanvas.height;
  if (r.mr) { r.mr.stop(); blob = await r.done; rec = null; }
  else {
    busyShow('Rendering…'); while (r.pending) await wait(30); rec = null;
    const fr = r.frames.filter(Boolean); if (fr.length < 2) { busyHide(); toast('Too short'); recL = 1400; return; }
    try { blob = r.type === 'timelapse' ? await exportTimelapse(fr) : await exportSlomo(fr, r.times.slice(0, fr.length)); } catch (e) { console.warn(e); toast('Render failed'); }
    busyHide();
  }
  recL = 1400; flashAnim();
  if (blob && blob.size) await store({ kind: 'video', blob, poster, look: `${mode().name} · ${lookName()}`, ts: Date.now(), w, h });
  else toast('Recording failed');
}
async function playFrames(count, drawFrame, fps = 30) { // render frames to recCanvas in real time into a MediaRecorder
  const r = startRecorder(recCanvas, null), dt = 1000 / fps, t0 = performance.now();
  for (let i = 0; i < count; i++) {
    await drawFrame(i); $('#busyMsg').textContent = `Rendering ${Math.round(i / count * 100)}%`;
    const target = t0 + (i + 1) * dt, d = target - performance.now(); if (d > 0) await wait(d);
  }
  await wait(700); r.mr.stop(); return r.done;  // hold the last frame so very short clips still flush
}
async function exportTimelapse(frames) {
  return playFrames(frames.length, async i => { const bmp = await createImageBitmap(frames[i]); recCtx.drawImage(bmp, 0, 0); bmp.close && bmp.close(); });
}
async function exportSlomo(frames, times) {
  const f = S.sm, dur = (times[times.length - 1] - times[0]) / 1000, n = Math.max(2, Math.floor(dur * f * 30));
  let ia = -1, ib = -1, A = null, B = null;
  const get = async i => { const bmp = await createImageBitmap(frames[i]); return bmp; };
  return playFrames(n, async k => {
    const t = times[0] + (k / 30 / f) * 1000; let i = ia < 0 ? 0 : ia; while (i < times.length - 2 && times[i + 1] <= t) i++;
    if (i !== ia) { if (i === ib && B) { A && A.close && A.close(); A = B; } else { A && A.close && A.close(); A = await get(i); } B = await get(i + 1); ia = i; ib = i + 1; }
    const a = Math.min(1, Math.max(0, (t - times[i]) / Math.max(1, times[i + 1] - times[i])));
    recCtx.globalAlpha = 1; recCtx.drawImage(A, 0, 0); recCtx.globalAlpha = a; recCtx.drawImage(B, 0, 0); recCtx.globalAlpha = 1;
  });
}

/* ---------- panorama (gyro-stitched strips) ---------- */
let pano = null;
async function startPano() {
  try { if (window.DeviceMotionEvent && DeviceMotionEvent.requestPermission) { const p = await DeviceMotionEvent.requestPermission(); if (p !== 'granted') throw 0; } }
  catch { toast('Motion access is needed for Pano'); return; }
  const [w, h] = previewSize(); recL = 1400; draw(w, h, false);
  const cv = document.createElement('canvas'); cv.height = view.height; cv.width = 9000;
  pano = { cv, ctx: cv.getContext('2d'), pos: 0, drawn: 0, rate: 0, last: performance.now(), sign: 0, acc: 0 };
  pano.onmotion = e => { const r = e.rotationRate; if (r) pano.rate = r.gamma || 0; };
  window.addEventListener('devicemotion', pano.onmotion);
  app.classList.add('pano-on'); $('#shutter').classList.add('rec'); $('#panoFill').style.width = '0%'; lock(true);
}
function panoTick() {
  const p = pano, now = performance.now(), dt = (now - p.last) / 1000; p.last = now;
  const sa = video.videoWidth / video.videoHeight, A = view.width / view.height;
  const ppd = view.width / ((48 / zoom) * Math.min(1, A / sa));       // pixels per degree across the frame
  let d = p.rate * dt * ppd;                                         // signed pixel shift
  if (!p.sign) { p.acc += d; if (Math.abs(p.acc) > 25) p.sign = Math.sign(p.acc); return; }
  d *= p.sign; if (d <= 0) return;
  p.pos += d; const want = Math.floor(p.pos), sw = want - p.drawn;
  if (sw >= 1) {
    const sx = Math.round(view.width / 2 - sw / 2);
    p.ctx.drawImage(view, sx, 0, sw, view.height, p.drawn, 0, sw, view.height); p.drawn = want;
    $('#panoFill').style.width = Math.min(100, want / p.cv.width * 100) + '%';
    if (want >= p.cv.width - 40) stopPano();
  }
}
async function stopPano() {
  const p = pano; if (!p) return; pano = null;
  window.removeEventListener('devicemotion', p.onmotion); app.classList.remove('pano-on'); $('#shutter').classList.remove('rec'); lock(false);
  if (p.drawn < view.width * 0.8) { toast('Pan further to make a panorama'); return; }
  const out = document.createElement('canvas'); out.width = p.drawn; out.height = p.cv.height; const x = out.getContext('2d'); x.drawImage(p.cv, 0, 0);
  if (S.stamp) stampText(x, out.width, out.height);
  const blob = await jpeg(out, S.q); flashAnim();
  if (blob) await store({ kind: 'photo', blob, look: `Pano · ${lookName()}`, ts: Date.now(), w: out.width, h: out.height });
}

/* ---------- shutter ---------- */
let busy = false;
async function onShutter() {
  $('#tune').classList.remove('open'); $('#btnTune').classList.remove('on');
  if (busy) return;
  const m = mode();
  if (rec) return stopRec();
  if (pano) return stopPano();
  busy = true;
  try {
    if (S.timer) { const cd = $('#countdown'); for (let i = S.timer; i > 0; i--) { cd.textContent = i; await wait(1000); } cd.textContent = ''; }
    if (m.id === 'pano') await startPano();
    else if (m.kind === 'video') await startRec();
    else await shootPhoto();
  } catch (e) { console.warn(e); toast('Something went wrong'); }
  busy = false;
}

/* ---------- modes ---------- */
function renderModes() {
  const box = $('#modes'); box.innerHTML = '';
  for (const m of MODES) { const b = document.createElement('button'); b.textContent = m.name; b.dataset.id = m.id; b.onclick = () => setMode(m.id); box.appendChild(b); }
  markMode(false);
}
function markMode(scroll = true) {
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.id === S.mode));
  const el = document.querySelector('#modes .on'); if (el) { if (scroll) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); else $('#modes').scrollLeft = el.offsetLeft - $('#modes').clientWidth / 2 + el.offsetWidth / 2; }
}
async function setMode(id) {
  if (rec || pano || busy) return;
  S.mode = id; const m = mode(); S.aspect = m.asp; applyAspect(); save();
  app.dataset.mode = id; app.dataset.fx = m.fx ? 1 : 0;
  $('#shutter').className = m.kind === 'video' ? 'video' : (id === 'pano' ? 'pano' : '');
  markMode(); updateHud(); rack = rackTarget = 0;
  if (m.fx) loadSeg();
  if (stream && camClass !== m.cls) { zoom = 1; try { await startCamera(); await buildLenses(); } catch { toast('Camera mode unavailable'); } }
  if (id === 'slomo') toast(`Camera running at ~${Math.round(startCamera.fps)} fps — playback is time-stretched ${S.sm}×`);
}

/* ---------- gallery ---------- */
let thumbURL = null;
async function updateThumb() {
  const all = await tx('photos', 'readonly', s => s.getAll()).catch(() => []);
  if (thumbURL) URL.revokeObjectURL(thumbURL);
  const last = all && all[all.length - 1];
  thumbURL = last ? URL.createObjectURL(last.poster || last.blob) : null;
  $('#thumb').style.backgroundImage = thumbURL ? `url(${thumbURL})` : 'none';
}
let galURLs = [], cur = null, curURL = null;
async function openGallery() {
  const all = ((await tx('photos', 'readonly', s => s.getAll())) || []).reverse();
  galURLs.forEach(URL.revokeObjectURL); galURLs = [];
  const g = $('#galGrid'); g.innerHTML = '';
  $('#galCount').textContent = all.length + (all.length === 1 ? ' item' : ' items');
  if (!all.length) g.innerHTML = '<div class="empty">Nothing here yet.<br>Shoot something and it lands here.<br>Tap <b>Add LUT</b> to import your own .cube files.</div>';
  for (const p of all) {
    const url = URL.createObjectURL(p.poster || p.blob); galURLs.push(url);
    const d = document.createElement('div'); d.style.backgroundImage = `url(${url})`; if (p.kind === 'video') d.className = 'vid'; d.onclick = () => openViewer(p); g.appendChild(d);
  }
  $('#gallery').classList.remove('hidden'); loop.pause = true;
}
function openViewer(p) {
  cur = p; if (curURL) URL.revokeObjectURL(curURL); curURL = URL.createObjectURL(p.blob);
  const st = $('#vStage'); st.innerHTML = '';
  const el = document.createElement(p.kind === 'video' ? 'video' : 'img'); el.src = curURL;
  if (p.kind === 'video') { el.controls = true; el.playsInline = true; el.autoplay = true; el.loop = true; }
  st.appendChild(el); $('#vInfo').textContent = p.look; $('#viewer').classList.remove('hidden');
}
function closeViewer() { const v = $('#vStage video'); if (v) v.pause(); $('#viewer').classList.add('hidden'); }
async function savePhoto() {
  if (!cur) return;
  const isV = cur.kind === 'video', ext = isV ? (cur.blob.type.includes('webm') ? 'webm' : 'mp4') : 'jpg';
  const file = new File([cur.blob], `LUMA-${cur.ts}.${ext}`, { type: cur.blob.type || (isV ? 'video/mp4' : 'image/jpeg') });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(cur.blob); a.download = file.name; a.click(); }
  } catch (e) { if (e.name !== 'AbortError') toast('Touch & hold to save'); }
}

/* ---------- UI wiring ---------- */
function applyAspect() { $('#btnAspect').textContent = ASPECTS[S.aspect][0]; $('#frame').style.aspectRatio = ASPECTS[S.aspect][1]; }
function applyTimer() { $('#timerLabel').textContent = S.timer ? S.timer + 's' : 'Off'; $('#btnTimer').classList.toggle('on', !!S.timer); }
function applyGrid() { $('#grid').classList.toggle('on', S.grid); $('#btnGrid').classList.toggle('on', S.grid); }
function bindSlider(id, key, f) {
  const r = $(id), o = r.parentElement.querySelector('output');
  const upd = () => { S[key] = +r.value; r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%'); o.textContent = f ? f(S[key]) : S[key]; };
  r.value = S[key]; upd(); r.oninput = () => { upd(); save(); };
}
function bindSeg(id, key) {
  const box = $(id), mark = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === +S[key]));
  box.onclick = e => { const b = e.target.closest('button'); if (!b) return; S[key] = +b.dataset.v; mark(); save(); }; mark();
}
$('#btnAspect').onclick = () => { if (rec) return; S.aspect = (S.aspect + 1) % ASPECTS.length; applyAspect(); save(); };
$('#btnTimer').onclick = () => { S.timer = TIMERS[(TIMERS.indexOf(S.timer) + 1) % TIMERS.length]; applyTimer(); save(); };
$('#btnGrid').onclick = () => { S.grid = !S.grid; applyGrid(); save(); };
$('#btnTune').onclick = e => { $('#tune').classList.toggle('open'); e.currentTarget.classList.toggle('on'); };
$('#lookName').onclick = () => { S.looksOpen = !S.looksOpen; applyLooksOpen(); save(); };
function applyLooksOpen() { $('#looks').classList.toggle('closed', !S.looksOpen); $('#lookName').classList.toggle('closed', !S.looksOpen); }
$('#shutter').onclick = onShutter;
$('#btnFlip').onclick = async () => { S.facing = S.facing === 'user' ? 'environment' : 'user'; save(); zoom = 1; await startCamera(); await buildLenses(); };
$('#btnGallery').onclick = openGallery;
$('#galClose').onclick = () => { $('#gallery').classList.add('hidden'); loop.pause = false; };
$('#vClose').onclick = closeViewer;
$('#vSave').onclick = savePhoto;
$('#vDel').onclick = async () => { if (!cur || !confirm('Delete this item?')) return; await tx('photos', 'readwrite', s => s.delete(cur.id)); closeViewer(); openGallery(); updateThumb(); };
$('#btnImport').onclick = () => $('#cubeFile').click();
$('#cubeFile').onchange = async e => {
  for (const f of e.target.files) {
    try {
      const text = await f.text(); const lut = parseCube(text);
      const name = f.name.replace(/\.cube$/i, ''), id = 'cube-' + name.toLowerCase().replace(/\W+/g, '-');
      await tx('luts', 'readwrite', s => s.put({ id, name, text })); luts[id] = lut;
      if (!allLooks.find(l => l.id === id)) allLooks.push({ id, name, custom: true });
      toast('Added ' + name);
    } catch { toast('Not a valid 3D .cube file'); }
  }
  e.target.value = ''; renderLooks();
};

/* ---------- boot ---------- */
(function logo() {
  const cols = ['#ffcf5a', '#ff965a', '#ff6e82', '#be6eff', '#6ea0ff', '#5adcc8'];
  $('#blades').innerHTML = cols.map((c, i) => `<polygon transform="rotate(${i * 60} 50 50)" fill="${c}" points="${50 + 34 * Math.cos(-0.49)},${50 + 34 * Math.sin(-0.49)} ${50 + 34 * Math.cos(0.49)},${50 + 34 * Math.sin(0.49)} ${50 + 12 * Math.cos(1.05)},${50 + 12 * Math.sin(1.05)}" opacity=".92"/>`).join('');
})();
bindSlider('#rInt', 'int', v => v + '%'); bindSlider('#rExp', 'exp', v => (v / 50).toFixed(1)); bindSlider('#rGrain', 'grain'); bindSlider('#rVig', 'vig'); bindSlider('#rBlur', 'blur');
bindSeg('#segLight', 'light'); bindSeg('#segTl', 'tl'); bindSeg('#segSm', 'sm'); bindSeg('#segStamp', 'stamp'); bindSeg('#segQ', 'q');
if (![0.5, 1, 2, 5].includes(S.tl)) S.tl = 1;
applyTimer(); applyGrid(); applyLooksOpen(); renderModes();
if (!MODES.find(m => m.id === S.mode)) S.mode = 'photo';
{ const m = mode(); S.aspect = Math.min(S.aspect, ASPECTS.length - 1); app.dataset.mode = m.id; app.dataset.fx = m.fx ? 1 : 0; $('#shutter').className = m.kind === 'video' ? 'video' : (m.id === 'pano' ? 'pano' : ''); applyAspect(); markMode(false); }
loadCustomLuts().then(() => { if (!luts[S.look]) S.look = 'natural'; renderLooks(); useLut(S.look); });
updateThumb();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) $('#gateMsg').textContent = 'Camera needs a secure (https) connection.';
else if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) $('#gateMsg').innerHTML = 'Tap <b>Share</b> → <b>Add to Home Screen</b>, then open LUMA from your Home Screen for the full-screen camera.';
$('#btnStart').onclick = async () => {
  try {
    await startCamera(); await buildLenses();
    $('#gate').classList.add('hidden'); requestAnimationFrame(loop);
    if (mode().fx) loadSeg();
  } catch (e) { $('#gateMsg').textContent = 'Camera blocked. Allow camera access in Settings → Safari (or LUMA), then try again.'; }
};
document.addEventListener('visibilitychange', async () => { if (!document.hidden && stream && !stream.active) { try { await startCamera(); } catch {} } });
