// Layer masks -> printer G-code.
// Machine rules copied from each printer's own files: Foodbot = models/*.gcode (Cura 15),
// candy sugar machine = 664430.png.stl.*.gcode (iceman3d). Per-print values come from settings.js.
import { printerOf } from './settings.js';

export const CELL_MM = 0.1;          // mask resolution
const FAN_FULL_HEIGHT = 0.5;         // fan_full_height in the profile

// imageData is already scaled to the mask grid (1 pixel = CELL_MM).
export function buildMask({ data, width, height }, { mode = 'dark', threshold = 128, invert = false } = {}) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3] / 255;
    let on;
    if (mode === 'alpha') {
      on = a > 0.5;
    } else {
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a); // transparent = white
      on = lum < threshold;
    }
    mask[i] = on !== invert ? 1 : 0;
  }
  return mask;
}

// Chamfer (3-4) distance from each set cell to the nearest unset cell, in mm.
// edge is what lies beyond the grid: 0 = unset, 1e9 = far away.
function distanceMap(mask, w, h, edge = 0) {
  const d = new Float32Array(w * h);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? edge : d[y * w + x]);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 1e9 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = (d[i] / 3) * CELL_MM;
  return d;
}

// Boundary loops of a binary grid, in cell-corner coordinates.
// Outer boundaries come out with positive area(), holes with negative.
function traceContours(inside, w, h) {
  const isIn = (x, y) => x >= 0 && y >= 0 && x < w && y < h && inside[y * w + x];
  const key = (x, y) => y * (w + 1) + x;
  const out = new Map(); // vertex key -> list of edge ends
  const add = (x0, y0, x1, y1) => {
    const k = key(x0, y0);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([x1, y1]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside[y * w + x]) continue;
      if (!isIn(x, y - 1)) add(x, y, x + 1, y);
      if (!isIn(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!isIn(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!isIn(x - 1, y)) add(x, y + 1, x, y);
    }
  }

  const loops = [];
  for (const [startKey, list] of out) {
    while (list.length) {
      const sx = startKey % (w + 1), sy = Math.floor(startKey / (w + 1));
      const pts = [[sx, sy]];
      let next = list.pop();
      while (next) {
        const [nx, ny] = next;
        if (nx === sx && ny === sy) break;
        pts.push([nx, ny]);
        const l = out.get(key(nx, ny));
        next = l && l.pop();
      }
      // Edge midpoints cut stair-step corners to 45 degrees.
      const mids = pts.map((p, i) => {
        const q = pts[(i + 1) % pts.length];
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      });
      loops.push(mids);
    }
  }
  return loops;
}

function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len;
      if (dist > bestD) { bestD = dist; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// RDP needs distinct end points, so split the loop at the vertex farthest from its start.
function simplifyLoop(loop, tol) {
  let m = 0, best = -1;
  for (let i = 0; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > best) { best = d; m = i; }
  }
  const a = simplify(loop.slice(0, m + 1), tol);
  const b = simplify([...loop.slice(m), loop[0]], tol);
  return [...a, ...b.slice(1)];
}

function polyLength(pts, closed) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 1) len += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
  return len;
}

const cleanLoops = (loops) => loops
  .map((loop) => simplifyLoop(loop, 0.7))
  .filter((loop) => polyLength(loop, false) * CELL_MM >= 1);

// Loop i runs along dist = bead * (i + 0.5), so the outer one touches the edge.
function wallLoops(dist, w, h, bead, count) {
  const walls = [];
  const m = new Uint8Array(w * h);
  for (let i = 0; i < count; i++) {
    const t = bead * (i + 0.5);
    let any = 0;
    for (let k = 0; k < dist.length; k++) any |= m[k] = dist[k] > t ? 1 : 0;
    if (!any) break;
    walls.push(cleanLoops(traceContours(m, w, h)));
  }
  return walls; // [outer, ..., inner]
}

// Strokes thinner than the bead never reach dist > bead/2, so wallLoops skips them.
// Grow each such stroke to just over one bead wide so a wall loop runs along it.
function widenThin(mask, dist, w, h, bead) {
  const r = bead / 2;
  // A core only just past r breaks into scraps that cleanLoops drops, so demand a margin.
  const notCore = new Uint8Array(w * h);
  for (let k = 0; k < notCore.length; k++) notCore[k] = dist[k] > r + 2 * CELL_MM ? 0 : 1;
  const toCore = distanceMap(notCore, w, h, 1e9);
  const lost = new Uint8Array(w * h);
  for (let k = 0; k < lost.length; k++) lost[k] = mask[k] && toCore[k] > r + CELL_MM ? 1 : 0;

  const out = mask.slice();
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < lost.length; s++) {
    if (!lost[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, half = 0;
    for (let i = 0; i < comp.length; i++) {
      const k = comp[i], x = k % w, y = (k - x) / w;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      half = Math.max(half, dist[k]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, n = ny * w + nx;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && lost[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
        }
      }
    }
    // Leftover corners of thick shapes are smaller than this; leave them alone.
    if (Math.max(x1 - x0, y1 - y0) * CELL_MM < bead * 0.6) continue;
    const g = Math.max(0, Math.ceil((r - half) / CELL_MM)) + 3; // a few cells past one bead, or the loop is a sliver that breaks up
    for (const k of comp) {
      const x = k % w, y = (k - x) / w;
      for (let dy = -g; dy <= g; dy++) {
        for (let dx = -g; dx <= g; dx++) {
          const nx = x + dx, ny = y + dy;
          if (dx * dx + dy * dy <= g * g && nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

// Where a loop's two sides lie closer than two beads they overlap, so scale its flow down
// (0.5 when they coincide, as on a widened thin stroke).
function wallFlow(dist, w, h, bead) {
  const R = Math.round(bead / CELL_MM);
  return (cx, cy) => {
    const x = Math.round(cx), y = Math.round(cy);
    let max = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const nx = x + dx, ny = y + dy;
        if (dx * dx + dy * dy <= R * R && nx >= 0 && ny >= 0 && nx < w && ny < h) max = Math.max(max, dist[ny * w + nx]);
      }
    }
    const inner = Math.max(0, 2 * max - bead);
    return Math.min(1, (inner + bead) / (2 * bead));
  };
}

// Brim loops around the outside of the first layer, outermost first.
// Returned in the layer's cell coordinates (may be negative).
function brimLoops(mask, w, h, bead, lines) {
  const p = Math.ceil((lines * bead + 1) / CELL_MM);
  const W = w + 2 * p, H = h + 2 * p;
  const far = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (mask[y * w + x]) far[(y + p) * W + x + p] = 0;
  }
  const d = distanceMap(far, W, H, 1e9);
  const region = new Uint8Array(W * H);
  const loops = [];
  for (let i = lines - 1; i >= 0; i--) {
    const t = bead * (i + 0.5);
    for (let k = 0; k < d.length; k++) region[k] = d[k] < t ? 1 : 0;
    for (const loop of cleanLoops(traceContours(region, W, H))) {
      if (area(loop) > 0) loops.push(loop.map(([x, y]) => [x - p, y - p]));
    }
  }
  return loops;
}

// Scanline fill runs (cell-centre coordinates), ordered as a zigzag.
// Lines sit on a fixed grid so sparse fill stacks up between layers.
function fillRuns(inside, w, h, vertical, spacingMm, minMm) {
  const step = Math.max(1, Math.round(spacingMm / CELL_MM));
  const lines = vertical ? w : h;
  const along = vertical ? h : w;
  const minCells = minMm / CELL_MM;
  const runs = [];
  let flip = false;
  for (let l = Math.floor(step / 2); l < lines; l += step) {
    const row = [];
    let start = -1;
    for (let t = 0; t <= along; t++) {
      const on = t < along && (vertical ? inside[t * w + l] : inside[l * w + t]);
      if (on && start < 0) start = t;
      if (!on && start >= 0) {
        if (t - start >= minCells) row.push([start + 0.5, t - 0.5]);
        start = -1;
      }
    }
    if (!row.length) continue;
    if (flip) row.reverse().forEach((r) => r.reverse());
    for (const [a, b] of row) {
      runs.push(vertical ? [[l + 0.5, a], [l + 0.5, b]] : [[a, l + 0.5], [b, l + 0.5]]);
    }
    flip = !flip;
  }
  return runs;
}

export function layerCount(heightMm, s) {
  if (heightMm <= 0) return 0;
  return 1 + Math.max(0, Math.ceil((heightMm - s.firstLayer) / s.layerHeight - 1e-6));
}

export function layerZ(L, s) {
  return s.firstLayer + L * s.layerHeight;
}

// getMask(L) -> Uint8Array(w * h), grid y down, centred on the bed.
export function buildGcode({ layers, w, h, getMask, settings: s, name = 'model', onProgress }) {
  const P = printerOf(s);
  const wMm = w * CELL_MM, hMm = h * CELL_MM, zMm = layerZ(layers - 1, s);
  if (wMm > P.maxX + 1e-6 || hMm > P.maxY + 1e-6 || zMm > P.maxZ + 1e-6) {
    return { error: `Model çox böyükdür: ${wMm.toFixed(0)} × ${hMm.toFixed(0)} × ${zMm.toFixed(1)} mm (maks. ${P.maxX} × ${P.maxY} × ${P.maxZ})` };
  }

  const cura = P.dialect === 'cura15';
  const bead = s.nozzle;
  const filamentArea = Math.PI * (P.filamentDiameter / 2) ** 2;
  const wallCount = Math.max(1, Math.round(s.wallThickness / bead));
  const solidCount = Math.round(s.solidThickness / s.layerHeight);
  const retract = s.retractAmount > 0;
  const fillEdge = bead * (wallCount + 0.5 - s.fillOverlap / 100) - 0.05;
  const sparseSpacing = s.fillDensity > 0 ? bead / (s.fillDensity / 100) : Infinity;
  const printF = s.printSpeed * 60, firstF = s.firstLayerSpeed * 60;
  const travelF = s.travelSpeed * 60, retractF = s.retractSpeed * 60;

  const cache = new Map();
  const maskAt = (L) => {
    if (L < 0 || L >= layers) return null;
    if (!cache.has(L)) cache.set(L, getMask(L));
    return cache.get(L);
  };

  // Grid (cells, y down) -> machine mm (y up), centred on the bed.
  const toX = (cx) => P.centerX - wMm / 2 + cx * CELL_MM;
  const toY = (cy) => P.centerY + hMm / 2 - cy * CELL_MM;

  const body = [];
  let x = P.centerX, y = P.centerY, z = cura ? 6 : 2, e = 0, f = 0;
  let retracted = retract; // the Cura start block ends with a retract
  let time = 0, walls0 = 0, printed = false, fanOn = false;
  const n = (v, d = 3) => v.toFixed(d);

  // Both machines' files only repeat F when it changes.
  const travel = (tx, ty, tz) => {
    const d = Math.hypot(tx - x, ty - y);
    if (retract && !retracted && (d > s.retractMinTravel || tz !== undefined)) {
      body.push(`G1 F${retractF} E${n(e - s.retractAmount, 5)}`);
      retracted = true;
      f = retractF;
    }
    body.push(`G0${f !== travelF ? ` F${travelF}` : ''} X${n(tx)} Y${n(ty)}${tz !== undefined ? ` Z${n(tz)}` : ''}`);
    f = travelF;
    time += d / s.travelSpeed;
    x = tx; y = ty;
    if (tz !== undefined) z = tz;
  };
  const extrude = (tx, ty, layerH, speedF, flow = 1) => {
    if (retracted) {
      body.push(`G1 F${retractF} E${n(e, 5)}`);
      retracted = false;
      f = retractF;
    }
    const d = Math.hypot(tx - x, ty - y);
    if (d < 1e-4) return;
    e += (d * bead * layerH * flow) / filamentArea;
    body.push(`G1${f !== speedF ? ` F${speedF}` : ''} X${n(tx)} Y${n(ty)} E${n(e, 5)}`);
    f = speedF;
    time += d / (speedF / 60);
    x = tx; y = ty;
    printed = true;
  };

  body.push(`;Layer count: ${layers}`);
  for (let L = 0; L < layers; L++) {
    const mask = maskAt(L);
    const zL = layerZ(L, s);
    const layerH = L === 0 ? s.firstLayer : s.layerHeight;
    const speedF = L === 0 && !P.flat ? firstF : printF; // a flat print's one layer uses the print speed
    let first = true;
    body.push(`;LAYER:${L}`);
    if (!cura) {
      if (L === 0) body.push(';M107');
    } else if (!fanOn && zL >= FAN_FULL_HEIGHT - 1e-6) {
      body.push('M106 S255');
      fanOn = true;
    } else if (L === 0) {
      body.push('M107');
    }
    if (cura && L === 0 && retract) {
      body.push(`G1 F${retractF} E${n(e - s.retractAmount, 5)}`);
      f = retractF;
    }
    const moveTo = (px, py) => {
      travel(px, py, first ? zL : undefined);
      first = false;
    };
    const loop = (pts, flowAt) => {
      moveTo(toX(pts[0][0]), toY(pts[0][1]));
      if (s.loopDwell > 0) { // let the sugar reach the plate before moving
        body.push(`G4 P${Math.round(s.loopDwell * 1000)}`);
        time += s.loopDwell;
      }
      for (let i = 1; i <= pts.length; i++) {
        const p = pts[i % pts.length], q = pts[i - 1];
        const flow = flowAt ? flowAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) : 1;
        extrude(toX(p[0]), toY(p[1]), layerH, speedF, flow);
      }
    };
    const lines = (runs) => {
      for (const [[ax, ay], [bx, by]] of runs) {
        moveTo(toX(ax), toY(ay));
        extrude(toX(bx), toY(by), layerH, speedF);
      }
    };

    const dist = distanceMap(mask, w, h);
    // The candy machine prints outlines only, so thin strokes would be lost entirely.
    const wallDist = P.flat ? distanceMap(widenThin(mask, dist, w, h, bead), w, h) : dist;
    const flowAt = P.flat ? wallFlow(wallDist, w, h, bead) : null;
    const walls = wallLoops(wallDist, w, h, bead, wallCount);
    if (L === 0) walls0 = walls.reduce((sum, ws) => sum + ws.length, 0);

    // Solid where any of the solidCount layers above or below is missing.
    const fill = new Uint8Array(w * h);
    const cover = new Uint8Array(w * h);
    for (let i = 0; i < fill.length; i++) cover[i] = fill[i] = dist[i] > fillEdge ? 1 : 0;
    for (let k = 1; k <= solidCount; k++) {
      for (const m of [maskAt(L - k), maskAt(L + k)]) {
        if (!m) { cover.fill(0); break; }
        for (let i = 0; i < cover.length; i++) cover[i] &= m[i];
      }
    }
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < fill.length; i++) solid[i] = fill[i] & (cover[i] ^ 1);
    const vertical = L % 2 === 1;

    if (L === 0 && s.brim) {
      const brim = brimLoops(mask, w, h, bead, s.brimLines);
      if (brim.length) body.push(';TYPE:SKIRT');
      for (const b of brim) loop(b);
    }
    const sparse = Number.isFinite(sparseSpacing) ? fillRuns(cover, w, h, vertical, sparseSpacing, bead) : [];
    if (sparse.length) body.push(';TYPE:FILL');
    lines(sparse);
    for (let i = walls.length - 1; i >= 0; i--) {
      if (walls[i].length) body.push(i === 0 ? ';TYPE:WALL-OUTER' : ';TYPE:WALL-INNER');
      for (const wl of walls[i]) loop(wl, flowAt);
    }
    const skin = fillRuns(solid, w, h, vertical, bead, bead);
    if (skin.length) body.push(';TYPE:SKIN');
    lines(skin);

    for (const k of cache.keys()) if (k < L - solidCount) cache.delete(k);
    onProgress?.((L + 1) / layers);
  }

  const filamentMm = e;
  const grams = ((filamentMm * filamentArea) / 1000) * 0.9;
  const minutes = Math.max(1, Math.round(time / 60));

  const info = {
    s, P, name, wMm, hMm, zMm, wallCount, solidCount, minutes, grams, filamentMm,
    endE: e, endX: x, endY: y, endZ: z, retractF, travelF,
  };
  const { header, footer, eol } = cura ? cura15Blocks(info) : icemanBlocks(info);

  return {
    gcode: [...header, ...body, ...footer].join(eol), // line endings like each machine's own files
    stats: {
      widthMm: wMm, heightMm: hMm, zMm, layers, minutes, grams, walls: walls0,
      empty: !printed,
    },
  };
}

// Start/end blocks of the Cura profile in models/*.gcode (CRLF).
function cura15Blocks({ s, P, name, wMm, hMm, zMm, wallCount, solidCount, minutes, grams, filamentMm, endE, endX, endY, endZ, retractF, travelF }) {
  const header = [
    ';images: ?vmd5?',
    `;settings: layer_height: ${s.layerHeight}`,
    `;settings: fill_density: ${s.fillDensity}`,
    `;settings: travel_speed: ${s.travelSpeed}`,
    `;settings: bottom_layer_speed: ${s.firstLayerSpeed}`,
    ';settings: support_angle: 30',
    ';settings: suppor_surface: ?suppor_surface?',
    ';settings: support_fill_rate: 30',
    ';settings: support_xy_distance: 1',
    ';settings: support_z_distance: 0.5',
    ';settings: solid_layer_count: ?solid_layer_count?',
    ';settings: wall_count: ?wall_count?',
    ';settings: retraction_enable: 1',
    `;settings: retraction_speed: ${s.retractSpeed}`,
    `;settings: retraction_amount: ${s.retractAmount}`,
    `;settings: print_speed: ${s.printSpeed}`,
    `;settings: filament_diameter: ${P.filamentDiameter}`,
    ';settings: support: 0',
    `;settings: platform_adhesion: ${s.brim ? 'Brim' : 0}`,
    `;Print time: ${minutes} minutes`,
    `;Filament used: ${(filamentMm / 1000).toFixed(3)}m ${grams.toFixed(1)}g`,
    ';Filament cost: None',
    `;Source: ${name} (${wMm.toFixed(1)} x ${hMm.toFixed(1)} x ${zMm.toFixed(2)} mm)`,
    `;Nozzle: ${s.nozzle} mm, walls: ${wallCount}, solid layers: ${solidCount}, fill overlap: ${s.fillOverlap}%`,
    ';M190 S0 ;Uncomment to add your own bed temperature line',
    ';M109 S0 ;Uncomment to add your own temperature line',
    'G21        ;metric values',
    'G90        ;absolute positioning',
    'M82        ;set extruder to absolute mode',
    'M107       ;start with the fan off',
    'G28 X0 Y0  ;move X/Y to min endstops',
    'G28 Z0     ;move Z to min endstops',
    ';G1 Z0 F600 ;move the platform down 15mm',
    'G1 Z10 F3000',
    'G1 F9000 X100',
    'G92 E0',
    'G1 F300 E4.5',
    'G92 E0',
    'G1 F3000 E-2',
    'G1 Z6 F3000',
    'G1 Y100',
    '',
  ];

  const footer = [
    'M107',
    `G1 F${retractF} E${(endE - s.retractAmount).toFixed(5)}`,
    `G0 F${travelF} X${endX.toFixed(3)} Y${endY.toFixed(3)} Z${(endZ + 5).toFixed(3)}`,
    'G91',
    'G28 Y0                             ;move X/Y to min endstops, so the head is out of the way',
    'G1 E-3 F300                            ;retract the filament a bit before lifting the nozzle, to release some of the pressure',
    'M84                         ;steppers off',
    'G90                         ;absolute positioning',
    '',
  ];
  return { header, footer, eol: '\r\n' };
}

// Blocks of the candy sugar machine's file 664430.png.stl.*.gcode (iceman3d, LF).
// The M100 line is copied verbatim; what it controls is unknown.
function icemanBlocks({ s, P, wMm, hMm, zMm, wallCount, solidCount }) {
  const header = [
    ';Generated with iceman3d_SteamEngine DEV-15.04.2',
    'M100 L2.00 F-133000 T78         M572       ',
    `;Model size:X${wMm.toFixed(2)} Y${hMm.toFixed(2)} Z${zMm.toFixed(2)}`,
    ';id: 0',
    `;settings: layer_height: ${s.layerHeight.toFixed(1)}`,
    `;settings: fill_density: ${s.fillDensity}`,
    `;settings: travel_speed: ${s.travelSpeed}`,
    `;settings: bottom_layer_speed: ${s.firstLayerSpeed}`,
    ';settings: support_angle: 45',
    ';settings: suppor_surface: 5',
    ';settings: support_fill_rate: 10',
    ';settings: support_xy_distance: 2',
    ';settings: support_z_distance: 0.15',
    `;settings: solid_layer_count: ${solidCount}`,
    `;settings: wall_count: ${wallCount}`,
    ';settings: retraction_enable: 1',
    `;settings: retraction_speed: ${s.retractSpeed}`,
    `;settings: retraction_amount: ${s.retractAmount.toFixed(1)}`,
    `;settings: print_speed: ${s.printSpeed}`,
    `;settings: filament_diameter: ${P.filamentDiameter}`,
    `;settings: nozzle_size: ${s.nozzle}`,
    ';settings: support: None',
    `;settings: platform_adhesion: ${s.brim ? 'Brim' : 'None'}`,
    ...(s.temp > 0 ? [`M104 S${s.temp}`] : []), // heats while homing
    'G90',
    'G28 X Y F2400',
    'G0 X90 Y320 F3000',
    'G28 Z',
    ...(s.temp > 0 ? [`M109 S${s.temp}`] : []),
    'G92 E0',
    'G1 Z2 E8 F500',
    ...(s.startDwell > 0 ? [`G4 P${Math.round(s.startDwell * 1000)}`] : []), // sugar starts flowing
    'G92 E0',
    ';M107',
  ];

  const footer = [
    'M106 S255',
    ...(s.endDwell > 0 ? [`G4 P${Math.round(s.endDwell * 1000)}`] : []), // cool under the fan before moving out
    'G92 E0',
    'G1 Z0 E-10 F500',
    'G92 E0',
    'G28 X Y F2400',
    'G0 Y200 F1000',
    '',
  ];
  return { header, footer, eol: '\n' };
}
