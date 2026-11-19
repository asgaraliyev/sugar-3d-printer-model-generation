import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { parseGcode } from './gcode.js';
import { CELL_MM, buildMask, buildGcode, layerCount } from './converter.js';
import {
  PRINTERS, MATERIALS, printerOf, defaultSettings, applyNozzle, applyMaterial, loadSettings, saveSettings,
} from './settings.js';

const PRINT_SECONDS = 25;   // full print animation length

const canvas = document.getElementById('view');
const fileInput = document.getElementById('file');
const playBtn = document.getElementById('play');
const colorInput = document.getElementById('color');
const info = document.getElementById('info');

let settings = loadSettings();

// --- Scene ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
camera.position.set(60, 50, 60);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.5;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(40, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60 });
scene.add(sun);

const plate = new THREE.Mesh(
  new THREE.CircleGeometry(40, 64),
  new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.9 })
);
plate.rotation.x = -Math.PI / 2;
plate.receiveShadow = true;
scene.add(plate);

const material = new THREE.MeshStandardMaterial({
  color: colorInput.value, roughness: 0.35, metalness: 0.05,
});
const stlMaterial = new THREE.MeshStandardMaterial({ color: colorInput.value, roughness: 0.6 });
const beadGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);

// --- State ---
let mesh = null;
let stlMesh = null;
let total = 0;
let shown = 0;
let playing = false;

function frame(size, height) {
  controls.target.set(0, height / 2, 0);
  const dist = size * 2.2;
  camera.position.set(dist * 0.7, height / 2 + dist * 0.45, dist * 0.7);
  controls.update();
}

function buildMesh(segs) {
  if (mesh) { scene.remove(mesh); mesh.dispose(); }
  if (stlMesh) stlMesh.visible = false;
  const beadRadius = settings.nozzle / 2; // visual thickness of extruded sugar

  total = segs.length / 6;
  mesh = new THREE.InstancedMesh(beadGeometry, material, total);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Bounds in G-code space to center the model on the plate.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < segs.length; i += 3) {
    minX = Math.min(minX, segs[i]);     maxX = Math.max(maxX, segs[i]);
    minY = Math.min(minY, segs[i + 1]); maxY = Math.max(maxY, segs[i + 1]);
    minZ = Math.min(minZ, segs[i + 2]); maxZ = Math.max(maxZ, segs[i + 2]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  // G-code (x, y, z) -> three (x, z, -y)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion(), s = new THREE.Vector3(), m = new THREE.Matrix4();
  for (let i = 0; i < total; i++) {
    const o = i * 6;
    a.set(segs[o] - cx, segs[o + 2] - minZ + beadRadius, -(segs[o + 1] - cy));
    b.set(segs[o + 3] - cx, segs[o + 5] - minZ + beadRadius, -(segs[o + 4] - cy));
    dir.subVectors(b, a);
    const len = dir.length();
    q.setFromUnitVectors(up, dir.divideScalar(len || 1));
    s.set(beadRadius, len + beadRadius, beadRadius); // slight overlap hides joints
    m.compose(a.add(b).multiplyScalar(0.5), q, s);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  const height = maxZ - minZ;
  frame(Math.max(maxX - minX, maxY - minY, height), height);

  const layers = new Set();
  for (let i = 2; i < segs.length; i += 6) layers.add(segs[i]);
  return layers.size;
}

function loadGcodeText(text, name) {
  const segs = parseGcode(text);
  if (!segs.length) {
    info.textContent = `${name}: çap hərəkəti tapılmadı`;
    return;
  }
  const layers = buildMesh(segs);
  info.textContent = `${name} · ${layers} qat · ${total.toLocaleString()} xətt`;
  shown = 0;
  setPlaying(true);
  playBtn.disabled = false;
}

function loadFile(file) {
  if (!file) return;
  if (file.type.startsWith('image/')) { loadImage(file); return; }
  if (/\.stl$/i.test(file.name)) { loadStl(file); return; }
  info.textContent = `${file.name} yüklənir…`;
  const reader = new FileReader();
  reader.onload = () => loadGcodeText(reader.result, file.name);
  reader.onerror = () => { info.textContent = `${file.name} oxunmadı`; };
  reader.readAsText(file);
}

function setPlaying(on) {
  playing = on;
  playBtn.textContent = on ? 'Dayandır' : 'Oynat';
}

// --- Source: image or STL ---
const panel = document.getElementById('panel');
const imageOpts = document.getElementById('imageOpts');
const stlOpts = document.getElementById('stlOpts');
const imageInput = document.getElementById('image');
const stlInput = document.getElementById('stl');
const preview = document.getElementById('preview');
const previewNote = document.getElementById('previewNote');
const widthInput = document.getElementById('width');
const layersInput = document.getElementById('layers');
const modeSelect = document.getElementById('mode');
const thresholdInput = document.getElementById('threshold');
const thresholdRow = document.getElementById('thresholdRow');
const invertInput = document.getElementById('invert');
const stlNote = document.getElementById('stlNote');
const stlSizeInput = document.getElementById('stlSize');
const generateBtn = document.getElementById('generate');
const downloadBtn = document.getElementById('download');

let source = 'image';
let sourceImage = null;
let sourceName = '';
let current = null;   // { mask, w, h }
let stl = null;       // { base, rot, name }
let stlTris = null;   // transformed triangles, mm
let stlDims = null;   // { x, y, z } mm
let worker = null;
let generated = null; // { gcode, name }

function clampInput(input) {
  const v = Math.round(Number(input.value));
  const clamped = Math.min(Number(input.max), Math.max(Number(input.min), Number.isFinite(v) ? v : Number(input.min)));
  input.value = clamped;
  return clamped;
}

function refreshGenerate() {
  generateBtn.disabled = Boolean(worker) || !(source === 'stl' ? stlTris : current);
}

// Anything that changes the output drops the old G-code.
function invalidate() {
  if (worker) {
    worker.terminate();
    worker = null;
    info.textContent = 'Ayar dəyişdi — yenidən "G-code yarat" basın';
  }
  generated = null;
  downloadBtn.disabled = true;
  refreshGenerate();
}

function setSource(next) {
  source = next;
  imageOpts.hidden = next !== 'image';
  stlOpts.hidden = next !== 'stl';
  if (stlMesh && next !== 'stl') stlMesh.visible = false;
  panel.open = true;
  invalidate();
}

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    sourceImage = img;
    sourceName = file.name.replace(/\.[^.]+$/, '');
    setSource('image');
    updateMask();
  };
  img.onerror = () => { URL.revokeObjectURL(url); previewNote.textContent = 'Şəkil açılmadı'; };
  img.src = url;
}

const maskOptions = () => ({
  mode: modeSelect.value,
  threshold: Number(thresholdInput.value),
  invert: invertInput.checked,
});

// Part of the source image that holds the drawing, so empty margins don't eat the width.
// Found on a small copy; one pixel of that copy is kept as margin so outlines aren't cut.
function contentBox() {
  const iw = sourceImage.naturalWidth, ih = sourceImage.naturalHeight;
  const k = Math.min(1, 400 / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceImage, 0, 0, w, h);
  const mask = buildMask(ctx.getImageData(0, 0, w, h), maskOptions());
  // Specks under 4 pixels (e.g. a stray corner pixel in a .webp) don't count as drawing.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let i = 0; i < comp.length; i++) {
      const k = comp[i], x = k % w, y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, n = ny * w + nx;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
        }
      }
    }
    if (comp.length < 4) continue;
    for (const k of comp) {
      const x = k % w, y = (k - x) / w;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return { sx: 0, sy: 0, sw: iw, sh: ih }; // nothing found: whole image
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1);
  x1 = Math.min(w - 1, x1 + 1); y1 = Math.min(h - 1, y1 + 1);
  return { sx: x0 / k, sy: y0 / k, sw: (x1 - x0 + 1) / k, sh: (y1 - y0 + 1) / k };
}

function updateMask() {
  thresholdRow.style.display = modeSelect.value === 'dark' ? '' : 'none';
  if (!sourceImage) return;

  const { sx, sy, sw, sh } = contentBox();
  const widthMm = clampInput(widthInput);
  const w = Math.round(widthMm / CELL_MM);
  const h = Math.max(1, Math.round((w * sh) / sw));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, w, h);
  const mask = buildMask(ctx.getImageData(0, 0, w, h), maskOptions());
  current = { mask, w, h };

  // Preview: sugar color on dark background.
  const scale = Math.min(preview.width / w, preview.height / h);
  const pc = document.createElement('canvas');
  pc.width = w; pc.height = h;
  const pctx = pc.getContext('2d');
  const img = pctx.createImageData(w, h);
  const hex = parseInt(colorInput.value.slice(1), 16);
  const col = [hex >> 16, (hex >> 8) & 255, hex & 255];
  for (let i = 0; i < mask.length; i++) {
    const on = mask[i];
    img.data[i * 4] = on ? col[0] : 27;
    img.data[i * 4 + 1] = on ? col[1] : 29;
    img.data[i * 4 + 2] = on ? col[2] : 34;
    img.data[i * 4 + 3] = 255;
  }
  pctx.putImageData(img, 0, 0);
  const g = preview.getContext('2d');
  g.clearRect(0, 0, preview.width, preview.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(pc, (preview.width - w * scale) / 2, (preview.height - h * scale) / 2, w * scale, h * scale);
  previewNote.textContent = `${sourceName} · ${(w * CELL_MM).toFixed(0)} × ${(h * CELL_MM).toFixed(0)} mm`;

  invalidate();
}

const stlLoader = new STLLoader();

function loadStl(file) {
  info.textContent = `${file.name} yüklənir…`;
  const reader = new FileReader();
  reader.onload = () => {
    let geo;
    try {
      geo = stlLoader.parse(reader.result);
    } catch {
      info.textContent = `${file.name}: STL oxunmadı`;
      return;
    }
    if (geo.index) geo = geo.toNonIndexed();
    geo.computeBoundingBox();
    const d = geo.boundingBox.getSize(new THREE.Vector3());
    const longest = Math.max(d.x, d.y, d.z);
    if (!geo.attributes.position.count || !(longest > 0)) {
      info.textContent = `${file.name}: STL boşdur`;
      return;
    }
    stl = { base: geo, rot: new THREE.Matrix4(), name: file.name.replace(/\.[^.]+$/, '') };
    stlSizeInput.value = Math.round(Math.min(Number(stlSizeInput.max), Math.max(5, longest)));
    info.textContent = file.name;
    setSource('stl');
    updateStl();
  };
  reader.onerror = () => { info.textContent = `${file.name} oxunmadı`; };
  reader.readAsArrayBuffer(file);
}

// Rotate, scale to the chosen size, centre on the bed and drop to z = 0.
function updateStl() {
  if (!stl) return;
  const size = clampInput(stlSizeInput);
  const g = stl.base.clone().applyMatrix4(stl.rot);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const c = bb.getCenter(new THREE.Vector3()), d = bb.getSize(new THREE.Vector3());
  const k = size / Math.max(d.x, d.y, d.z);
  g.translate(-c.x, -c.y, -bb.min.z).scale(k, k, k);
  stlTris = g.attributes.position.array;
  stlDims = { x: d.x * k, y: d.y * k, z: d.z * k };

  if (stlMesh) {
    stlMesh.geometry.dispose();
    stlMesh.geometry = g;
  } else {
    stlMesh = new THREE.Mesh(g, stlMaterial);
    stlMesh.rotation.x = -Math.PI / 2; // STL is z-up, the scene is y-up
    stlMesh.castShadow = true;
    scene.add(stlMesh);
  }
  stlMesh.visible = true;
  if (mesh) mesh.visible = false;
  playBtn.disabled = true;
  frame(Math.max(stlDims.x, stlDims.y, stlDims.z), stlDims.z);

  updateStlNote();
  invalidate();
}

function updateStlNote() {
  if (!stlDims) return;
  const { x, y, z } = stlDims;
  const P = printerOf(settings);
  const warnings = [];
  if (x > P.maxX || y > P.maxY) warnings.push(`Maks. sahə ${P.maxX} × ${P.maxY} mm-dir — ölçünü kiçildin və ya Z üzrə döndərin.`);
  if (!P.flat && z > P.maxZ) warnings.push(`Hündürlük ${P.maxZ} mm-dən çoxdur — ölçünü kiçildin və ya döndərin.`);
  if (MATERIALS[settings.material].flatOnly) warnings.push('Bu material yalnız düz (2D) modellər üçündür.');
  const layersText = P.flat ? '1 qat (modelin ortasından kəsik)' : `${layerCount(z, settings)} qat`;
  stlNote.textContent = `${stl.name} · ${x.toFixed(0)} × ${y.toFixed(0)} × ${z.toFixed(1)} mm · ${layersText}`
    + (warnings.length ? ` · ⚠ ${warnings.join(' ')}` : '');
  stlNote.classList.toggle('warn', warnings.length > 0);
}

for (const btn of document.querySelectorAll('.rot .btn')) {
  btn.addEventListener('click', () => {
    if (!stl) return;
    const axis = btn.dataset.axis.toUpperCase();
    stl.rot.premultiply(new THREE.Matrix4()[`makeRotation${axis}`](Math.PI / 2));
    updateStl();
  });
}

// --- Generate ---
function finish(result, name, emptyMessage) {
  if (result.error) { info.textContent = result.error; return; }
  if (result.stats.empty) { info.textContent = emptyMessage; return; }
  generated = { gcode: result.gcode, name: `${name}.gcode` };
  downloadBtn.disabled = false;
  loadGcodeText(result.gcode, generated.name);
  info.textContent += ` · ~${result.stats.minutes} dəq · ~${result.stats.grams.toFixed(1)} q`;
}

function generateImage() {
  if (!current) return;
  const layers = clampInput(layersInput);
  const { mask, w, h } = current;
  const result = buildGcode({ layers, w, h, getMask: () => mask, settings, name: sourceName });
  finish(result, sourceName, 'Çap ediləcək hissə tapılmadı — "Tərsinə çevir" və ya həssaslığı dəyişin');
}

function generateStl() {
  if (!stlTris) return;
  const name = stl.name;
  const done = () => { worker.terminate(); worker = null; refreshGenerate(); };
  worker = new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.progress !== undefined) {
      info.textContent = `Dilimlənir… ${Math.round(data.progress * 100)}%`;
      return;
    }
    done();
    if (data.error) { info.textContent = `Dilimləmə xətası: ${data.error}`; return; }
    finish(data.result, name, 'Çap ediləcək hissə tapılmadı — model çox kiçik və ya nazikdir');
  };
  worker.onerror = () => { done(); info.textContent = 'Dilimləmə alınmadı'; };
  info.textContent = 'Dilimlənir… 0%';
  refreshGenerate();
  const tris = stlTris.slice();
  worker.postMessage({ tris, size: stlDims, settings, name }, [tris.buffer]);
}

generateBtn.addEventListener('click', () => (source === 'stl' ? generateStl() : generateImage()));

downloadBtn.addEventListener('click', () => {
  if (!generated) return;
  const url = URL.createObjectURL(new Blob([generated.gcode], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: generated.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

imageInput.addEventListener('change', () => { if (imageInput.files[0]) loadImage(imageInput.files[0]); imageInput.value = ''; });
stlInput.addEventListener('change', () => { if (stlInput.files[0]) loadStl(stlInput.files[0]); stlInput.value = ''; });
for (const el of [widthInput, modeSelect, thresholdInput, invertInput]) el.addEventListener('input', updateMask);
// Largest width whose height still fits the printer's area.
document.getElementById('fitMax').addEventListener('click', () => {
  if (!sourceImage) return;
  const P = printerOf(settings);
  const { sw, sh } = contentBox();
  widthInput.value = Math.floor(Math.min(P.maxX, (P.maxY * sw) / sh));
  updateMask();
});
layersInput.addEventListener('change', () => { clampInput(layersInput); invalidate(); });
stlSizeInput.addEventListener('change', updateStl);
updateMask();

// --- Print settings ---
const FIELDS = [
  { key: 'nozzle', label: 'Başlıq (mm)', options: true }, // from the printer
  { key: 'layerHeight', label: 'Qat hündürlüyü (mm)', min: 0.1, max: 3, step: 0.05 },
  { key: 'firstLayer', label: 'İlk qat (mm)', min: 0.1, max: 3, step: 0.05 },
  { key: 'wallThickness', label: 'Divar qalınlığı (mm)', min: 0.6, max: 5, step: 0.1 },
  { key: 'solidThickness', label: 'Üst/alt qalınlıq (mm)', min: 0, max: 5, step: 0.1 },
  { key: 'fillDensity', label: 'Doldurma (%)', min: 0, max: 100, step: 5 },
  { key: 'fillOverlap', label: 'Divara girmə (%)', min: 0, max: 50, step: 5 },
  { key: 'printSpeed', label: 'Çap sürəti (mm/s)', min: 5, max: 150, step: 1 },
  { key: 'firstLayerSpeed', label: 'İlk qat sürəti (mm/s)', min: 5, max: 150, step: 1, hideFor: 'candy' }, // one layer: print speed
  { key: 'travelSpeed', label: 'Boş hərəkət (mm/s)', min: 5, max: 150, step: 1 },
  { key: 'retractAmount', label: 'Geri çəkmə (mm)', min: 0, max: 10, step: 0.5 },
  { key: 'retractSpeed', label: 'Geri çəkmə sürəti (mm/s)', min: 5, max: 100, step: 5 },
  { key: 'retractMinTravel', label: 'Geri çəkmə min. yol (mm)', min: 0, max: 10, step: 0.5 },
  { key: 'brim', label: 'Brim', checkbox: true },
  { key: 'brimLines', label: 'Brim xətləri', min: 1, max: 20, step: 1 },
  { key: 'temp', label: 'Temperatur (℃, 0 = gözləmə)', min: 0, max: 200, step: 1, only: 'candy' },
  { key: 'startDwell', label: 'Başlanğıcda gözləmə (s)', min: 0, max: 30, step: 0.5, only: 'candy' },
  { key: 'loopDwell', label: 'Hər xəttdən əvvəl gözləmə (s)', min: 0, max: 5, step: 0.1, only: 'candy' },
  { key: 'endDwell', label: 'Sonda soyuma gözləməsi (s)', min: 0, max: 60, step: 1, only: 'candy' },
];

const printerSelect = document.getElementById('printer');
const materialSelect = document.getElementById('material');
const materialNote = document.getElementById('materialNote');
const settingsBox = document.getElementById('settings');
const inputs = {};

for (const [key, p] of Object.entries(PRINTERS)) printerSelect.add(new Option(p.label, key));

for (const f of FIELDS) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.htmlFor = `s-${f.key}`;
  label.textContent = f.label;
  let input;
  if (f.options) {
    input = document.createElement('select');
  } else {
    input = document.createElement('input');
    if (f.checkbox) input.type = 'checkbox';
    else Object.assign(input, { type: 'number', min: f.min, max: f.max, step: f.step });
  }
  input.id = `s-${f.key}`;
  input.addEventListener('change', () => onField(f, input));
  row.append(label, input);
  settingsBox.append(row);
  inputs[f.key] = input;
}

function onField(f, input) {
  if (f.key === 'nozzle') {
    settings = applyNozzle(settings, Number(input.value));
  } else if (f.checkbox) {
    settings = { ...settings, [f.key]: input.checked };
  } else {
    const v = Number(input.value);
    if (input.value !== '' && Number.isFinite(v)) {
      settings = { ...settings, [f.key]: Math.min(f.max, Math.max(f.min, v)) };
    }
  }
  settingsChanged();
}

function renderSettings() {
  const P = printerOf(settings);
  printerSelect.value = settings.printer;
  materialSelect.replaceChildren(...Object.entries(MATERIALS)
    .filter(([, m]) => m.printer === settings.printer)
    .map(([key, m]) => new Option(m.label, key)));
  materialSelect.value = settings.material;
  materialNote.textContent = MATERIALS[settings.material].note;
  inputs.nozzle.replaceChildren(...P.nozzles.map((o) => new Option(String(o), String(o))));
  for (const f of FIELDS) {
    inputs[f.key].parentElement.hidden = (f.only && f.only !== settings.printer) || f.hideFor === settings.printer;
    if (f.checkbox) inputs[f.key].checked = settings[f.key];
    else inputs[f.key].value = String(settings[f.key] ?? '');
  }
  inputs.brimLines.parentElement.hidden = !settings.brim;
  widthInput.max = P.maxX;
  stlSizeInput.max = Math.max(P.maxX, P.maxY);
  layersInput.max = P.flat ? 1 : 10;
}

function settingsChanged() {
  saveSettings(settings);
  renderSettings();
  updateStlNote();
  invalidate();
}

materialSelect.addEventListener('change', () => {
  settings = applyMaterial(settings, materialSelect.value);
  settingsChanged();
});
printerSelect.addEventListener('change', () => {
  saveSettings(settings);
  settings = loadSettings(printerSelect.value);
  settingsChanged();
  clampInput(layersInput);
  updateMask();
  updateStl();
});
document.getElementById('reset').addEventListener('click', () => {
  settings = defaultSettings(settings.printer);
  settingsChanged();
});
renderSettings();
clampInput(layersInput);

// --- UI ---
fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });

playBtn.addEventListener('click', () => {
  if (!playing && shown >= total) shown = 0; // replay once finished
  setPlaying(!playing);
});

colorInput.addEventListener('input', () => {
  material.color.set(colorInput.value);
  stlMaterial.color.set(colorInput.value);
  updateMask();
});

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});

// --- Loop ---
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (mesh) {
    if (playing) {
      shown = Math.min(total, shown + (total / PRINT_SECONDS) * dt);
      if (shown >= total) setPlaying(false);
    }
    mesh.count = Math.floor(shown);
  }
  controls.update();
  renderer.render(scene, camera);
});
