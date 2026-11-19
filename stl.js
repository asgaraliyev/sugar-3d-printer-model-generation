// STL triangles -> per-layer masks for converter.js.
// tris: flat xyz list (9 numbers per triangle) in mm, centred on x = y = 0, min z = 0.
import { CELL_MM } from './converter.js';

export function gridSize({ x, y }) {
  return { w: Math.max(1, Math.round(x / CELL_MM)), h: Math.max(1, Math.round(y / CELL_MM)) };
}

// Cross-section at height z, filled even-odd along each grid row (y down).
export function sliceMask(tris, z, w, h) {
  const halfW = (w * CELL_MM) / 2, halfH = (h * CELL_MM) / 2;
  const rows = Array.from({ length: h }, () => []);
  const pts = [];

  for (let t = 0; t < tris.length; t += 9) {
    pts.length = 0;
    for (let a = 0; a < 3; a++) {
      const i = t + a * 3, j = t + ((a + 1) % 3) * 3;
      const zi = tris[i + 2], zj = tris[j + 2];
      if ((zi > z) === (zj > z)) continue;
      const k = (z - zi) / (zj - zi);
      pts.push(tris[i] + k * (tris[j] - tris[i]), tris[i + 1] + k * (tris[j + 1] - tris[i + 1]));
    }
    if (pts.length !== 4) continue;

    const [xa, ya, xb, yb] = pts;
    if (ya === yb) continue;
    const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
    // Rows whose centre y lies in [lo, hi).
    const r0 = Math.max(0, Math.floor((halfH - hi) / CELL_MM - 0.5) + 1);
    const r1 = Math.min(h - 1, Math.floor((halfH - lo) / CELL_MM - 0.5));
    for (let r = r0; r <= r1; r++) {
      const yc = halfH - (r + 0.5) * CELL_MM;
      rows[r].push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
    }
  }

  const mask = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    const xs = rows[r].sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((xs[i] + halfW) / CELL_MM - 0.5));
      const c1 = Math.min(w, Math.ceil((xs[i + 1] + halfW) / CELL_MM - 0.5));
      mask.fill(1, r * w + c0, r * w + Math.max(c0, c1));
    }
  }
  return mask;
}
