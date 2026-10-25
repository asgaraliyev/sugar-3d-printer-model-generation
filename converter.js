// Image -> sugar printer G-code.
// Machine rules copied from the manufacturer's files in models/ (Cura 15 style).

export const CELL_MM = 0.1;          // mask resolution
const BEAD_WIDTH = 0.6;              // mm, measured from models/*.gcode
const FIRST_LAYER_Z = 0.4;
const LAYER_HEIGHT = 0.45;
const FILAMENT_AREA = Math.PI * 14 * 14; // filament_diameter: 28
const PRINT_F = 900;
const TRAVEL_F = 900;
const RETRACT_F = 3000;
const RETRACT_MM = 2;
const RETRACT_MIN_TRAVEL = 1;        // mm; shorter travels skip retraction
const CENTER_X = 100;
const CENTER_Y = 100;

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

// Chamfer (3-4) distance from each inside cell to the nearest outside cell, in mm.
function distanceMap(mask, w, h) {
  const d = new Float32Array(w * h);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
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

// Scanline fill runs (cell-centre coordinates), ordered as a zigzag.
function fillRuns(inside, w, h, vertical) {
  const step = Math.round(BEAD_WIDTH / CELL_MM);
  const lines = vertical ? w : h;
  const along = vertical ? h : w;
  const minCells = BEAD_WIDTH / CELL_MM;
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

export function maskToGcode(mask, w, h, { layers = 1, name = 'image' } = {}) {
  const dist = distanceMap(mask, w, h);
  const wallMask = new Uint8Array(w * h);
  const fillMask = new Uint8Array(w * h);
  for (let i = 0; i < dist.length; i++) {
    wallMask[i] = dist[i] > BEAD_WIDTH / 2 ? 1 : 0;
    fillMask[i] = dist[i] > BEAD_WIDTH * 1.5 - 0.05 ? 1 : 0;
  }

  const walls = traceContours(wallMask, w, h)
    .map((loop) => simplifyLoop(loop, 0.7))
    .filter((loop) => polyLength(loop, false) * CELL_MM >= 1);
  const fills = [fillRuns(fillMask, w, h, false), fillRuns(fillMask, w, h, true)];

  // Grid (cells, y down) -> machine mm (y up), centred on the bed.
  const wMm = w * CELL_MM, hMm = h * CELL_MM;
  const toX = (cx) => CENTER_X - wMm / 2 + cx * CELL_MM;
  const toY = (cy) => CENTER_Y + hMm / 2 - cy * CELL_MM;

  const body = [];
  let x = CENTER_X, y = CENTER_Y, z = 6, e = 0, f = 0;
  let retracted = true; // start block ends with a retract
  let time = 0;
  const n = (v, d = 3) => v.toFixed(d);

  const travel = (tx, ty, tz) => {
    const d = Math.hypot(tx - x, ty - y);
    if (!retracted && (d > RETRACT_MIN_TRAVEL || tz !== undefined)) {
      body.push(`G1 F${RETRACT_F} E${n(e - RETRACT_MM, 5)}`);
      retracted = true;
    }
    body.push(`G0 F${TRAVEL_F} X${n(tx)} Y${n(ty)}${tz !== undefined ? ` Z${n(tz)}` : ''}`);
    f = TRAVEL_F;
    time += d / (TRAVEL_F / 60);
    x = tx; y = ty;
    if (tz !== undefined) z = tz;
  };
  const extrude = (tx, ty, layerH) => {
    if (retracted) {
      body.push(`G1 F${RETRACT_F} E${n(e, 5)}`);
      retracted = false;
      f = RETRACT_F;
    }
    const d = Math.hypot(tx - x, ty - y);
    if (d < 1e-4) return;
    e += (d * BEAD_WIDTH * layerH) / FILAMENT_AREA;
    body.push(`G1${f !== PRINT_F ? ` F${PRINT_F}` : ''} X${n(tx)} Y${n(ty)} E${n(e, 5)}`);
    f = PRINT_F;
    time += d / (PRINT_F / 60);
    x = tx; y = ty;
  };

  body.push(`;Layer count: ${layers}`);
  for (let L = 0; L < layers; L++) {
    const layerZ = FIRST_LAYER_Z + L * LAYER_HEIGHT;
    const layerH = L === 0 ? FIRST_LAYER_Z : LAYER_HEIGHT;
    let first = true;
    body.push(`;LAYER:${L}`);
    if (L === 0) {
      body.push('M107');
      body.push(`G1 F${RETRACT_F} E${n(e - RETRACT_MM, 5)}`);
    }
    const moveTo = (px, py) => {
      travel(px, py, first ? layerZ : undefined);
      first = false;
    };

    if (walls.length) body.push(';TYPE:WALL-OUTER');
    for (const loop of walls) {
      moveTo(toX(loop[0][0]), toY(loop[0][1]));
      for (let i = 1; i < loop.length; i++) extrude(toX(loop[i][0]), toY(loop[i][1]), layerH);
    }

    const runs = fills[L % 2];
    if (runs.length) body.push(';TYPE:FILL');
    for (const [[ax, ay], [bx, by]] of runs) {
      moveTo(toX(ax), toY(ay));
      extrude(toX(bx), toY(by), layerH);
    }
  }

  const filamentMm = e;
  const grams = ((filamentMm * FILAMENT_AREA) / 1000) * 0.9;
  const minutes = Math.max(1, Math.round(time / 60));

  const header = [
    ';images: ?vmd5?',
    `;settings: layer_height: ${LAYER_HEIGHT}`,
    ';settings: fill_density: 100',
    ';settings: travel_speed: 15',
    ';settings: bottom_layer_speed: 15',
    ';settings: support_angle: 30',
    ';settings: suppor_surface: ?suppor_surface?',
    ';settings: support_fill_rate: 30',
    ';settings: support_xy_distance: 1',
    ';settings: support_z_distance: 0.5',
    ';settings: solid_layer_count: ?solid_layer_count?',
    ';settings: wall_count: ?wall_count?',
    ';settings: retraction_enable: 1',
    ';settings: retraction_speed: 50',
    `;settings: retraction_amount: ${RETRACT_MM}`,
    ';settings: print_speed: 25',
    ';settings: filament_diameter: 28',
    ';settings: support: 0',
    ';settings: platform_adhesion: 0',
    `;Print time: ${minutes} minutes`,
    `;Filament used: ${(filamentMm / 1000).toFixed(3)}m ${grams.toFixed(1)}g`,
    ';Filament cost: None',
    `;Source image: ${name} (${wMm.toFixed(1)} x ${hMm.toFixed(1)} mm)`,
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
    `G1 F${RETRACT_F} E${n(e - RETRACT_MM, 5)}`,
    `G0 F${TRAVEL_F} X${n(x)} Y${n(y)} Z${n(z + 5)}`,
    'G91',
    'G28 Y0                             ;move X/Y to min endstops, so the head is out of the way',
    'G1 E-3 F300                            ;retract the filament a bit before lifting the nozzle, to release some of the pressure',
    'M84                         ;steppers off',
    'G90                         ;absolute positioning',
    '',
  ];

  return {
    gcode: [...header, ...body, ...footer].join('\r\n'), // CRLF like the machine's own files
    stats: {
      widthMm: wMm, heightMm: hMm, layers, minutes, grams,
      walls: walls.length, fillLines: fills[0].length,
      empty: walls.length === 0 && fills[0].length === 0,
    },
  };
}
