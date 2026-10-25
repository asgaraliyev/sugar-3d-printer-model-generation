import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseGcode } from './gcode.js';
import { CELL_MM, buildMask, maskToGcode } from './converter.js';

const PRINT_SECONDS = 25;   // full print animation length
const BEAD_RADIUS = 0.3;    // mm, visual thickness of extruded sugar

const canvas = document.getElementById('view');
const fileInput = document.getElementById('file');
const playBtn = document.getElementById('play');
const colorInput = document.getElementById('color');
const info = document.getElementById('info');

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
const beadGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);

// --- State ---
let mesh = null;
let total = 0;
let shown = 0;
let playing = false;

function buildMesh(segs) {
  if (mesh) { scene.remove(mesh); mesh.dispose(); }

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
    a.set(segs[o] - cx, segs[o + 2] - minZ + BEAD_RADIUS, -(segs[o + 1] - cy));
    b.set(segs[o + 3] - cx, segs[o + 5] - minZ + BEAD_RADIUS, -(segs[o + 4] - cy));
    dir.subVectors(b, a);
    const len = dir.length();
    q.setFromUnitVectors(up, dir.divideScalar(len || 1));
    s.set(BEAD_RADIUS, len + BEAD_RADIUS, BEAD_RADIUS); // slight overlap hides joints
    m.compose(a.add(b).multiplyScalar(0.5), q, s);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  // Frame the camera on the model.
  const height = maxZ - minZ;
  const size = Math.max(maxX - minX, maxY - minY, height);
  controls.target.set(0, height / 2, 0);
  const dist = size * 2.2;
  camera.position.set(dist * 0.7, height / 2 + dist * 0.45, dist * 0.7);
  controls.update();

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

// --- Image -> G-code ---
const imageInput = document.getElementById('image');
const preview = document.getElementById('preview');
const previewNote = document.getElementById('previewNote');
const widthInput = document.getElementById('width');
const layersInput = document.getElementById('layers');
const modeSelect = document.getElementById('mode');
const thresholdInput = document.getElementById('threshold');
const thresholdRow = document.getElementById('thresholdRow');
const invertInput = document.getElementById('invert');
const generateBtn = document.getElementById('generate');
const downloadBtn = document.getElementById('download');

let sourceImage = null;
let sourceName = '';
let current = null; // { mask, w, h }
let generated = null; // { gcode, name }

function clampInput(input) {
  const v = Math.round(Number(input.value));
  const clamped = Math.min(Number(input.max), Math.max(Number(input.min), Number.isFinite(v) ? v : Number(input.min)));
  input.value = clamped;
  return clamped;
}

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    sourceImage = img;
    sourceName = file.name.replace(/\.[^.]+$/, '');
    document.getElementById('panel').open = true;
    updateMask();
    generateBtn.disabled = false;
  };
  img.onerror = () => { URL.revokeObjectURL(url); previewNote.textContent = 'Şəkil açılmadı'; };
  img.src = url;
}

function updateMask() {
  thresholdRow.style.display = modeSelect.value === 'dark' ? '' : 'none';
  if (!sourceImage) return;

  const widthMm = clampInput(widthInput);
  const w = Math.round(widthMm / CELL_MM);
  const h = Math.max(1, Math.round((w * sourceImage.naturalHeight) / sourceImage.naturalWidth));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceImage, 0, 0, w, h);
  const mask = buildMask(ctx.getImageData(0, 0, w, h), {
    mode: modeSelect.value,
    threshold: Number(thresholdInput.value),
    invert: invertInput.checked,
  });
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

  generated = null;
  downloadBtn.disabled = true;
}

generateBtn.addEventListener('click', () => {
  if (!current) return;
  const layers = clampInput(layersInput);
  const { gcode, stats } = maskToGcode(current.mask, current.w, current.h, { layers, name: sourceName });
  if (stats.empty) {
    info.textContent = 'Çap ediləcək hissə tapılmadı — "Tərsinə çevir" və ya həssaslığı dəyişin';
    return;
  }
  generated = { gcode, name: `${sourceName}.gcode` };
  downloadBtn.disabled = false;
  loadGcodeText(gcode, generated.name);
  info.textContent += ` · ~${stats.minutes} dəq · ~${stats.grams.toFixed(1)} q`;
});

downloadBtn.addEventListener('click', () => {
  if (!generated) return;
  const url = URL.createObjectURL(new Blob([generated.gcode], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: generated.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

imageInput.addEventListener('change', () => { if (imageInput.files[0]) loadImage(imageInput.files[0]); imageInput.value = ''; });
for (const el of [widthInput, modeSelect, thresholdInput, invertInput]) el.addEventListener('input', updateMask);
layersInput.addEventListener('change', () => clampInput(layersInput));
updateMask();

// --- UI ---
fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });

playBtn.addEventListener('click', () => {
  if (!playing && shown >= total) shown = 0; // replay once finished
  setPlaying(!playing);
});

colorInput.addEventListener('input', () => { material.color.set(colorInput.value); updateMask(); });

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
