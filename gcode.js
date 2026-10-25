// Parses G-code into extrusion segments [x0,y0,z0,x1,y1,z1, ...] in print order.
export function parseGcode(text) {
  const out = [];
  let x = 0, y = 0, z = 0, e = 0;
  let relative = false, relativeE = false;

  for (const raw of text.split('\n')) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    const cmd = parts[0].toUpperCase();

    if (cmd === 'G90') { relative = false; relativeE = false; continue; }
    if (cmd === 'G91') { relative = true; relativeE = true; continue; }
    if (cmd === 'M82') { relativeE = false; continue; }
    if (cmd === 'M83') { relativeE = true; continue; }

    if (cmd === 'G92') {
      for (const p of parts.slice(1)) {
        const v = parseFloat(p.slice(1));
        switch (p[0].toUpperCase()) {
          case 'X': x = v; break;
          case 'Y': y = v; break;
          case 'Z': z = v; break;
          case 'E': e = v; break;
        }
      }
      continue;
    }

    if (cmd !== 'G0' && cmd !== 'G1') continue;

    let nx = x, ny = y, nz = z, ne = e, hasE = false;
    for (const p of parts.slice(1)) {
      const v = parseFloat(p.slice(1));
      if (Number.isNaN(v)) continue;
      switch (p[0].toUpperCase()) {
        case 'X': nx = relative ? x + v : v; break;
        case 'Y': ny = relative ? y + v : v; break;
        case 'Z': nz = relative ? z + v : v; break;
        case 'E': ne = relativeE ? e + v : v; hasE = true; break;
      }
    }

    const extruding = cmd === 'G1' && hasE && ne > e && (nx !== x || ny !== y) && nz === z;
    if (extruding) out.push(x, y, z, nx, ny, nz);

    x = nx; y = ny; z = nz; e = ne;
  }

  return new Float32Array(out);
}
