// Slices an STL off the main thread so the page stays responsive.
import { buildGcode, layerCount, layerZ } from './converter.js';
import { printerOf } from './settings.js';
import { gridSize, sliceMask } from './stl.js';

onmessage = ({ data: { tris, size, settings, name } }) => {
  try {
    const { w, h } = gridSize(size);
    const flat = printerOf(settings).flat;
    const layers = flat ? 1 : layerCount(size.z, settings);
    const mid = (L) => (flat ? size.z / 2 : ((L === 0 ? 0 : layerZ(L - 1, settings)) + layerZ(L, settings)) / 2);
    const result = buildGcode({
      layers, w, h, settings, name,
      getMask: (L) => sliceMask(tris, mid(L), w, h),
      onProgress: (progress) => postMessage({ progress }),
    });
    postMessage({ result });
  } catch (err) {
    postMessage({ error: String(err?.message || err) });
  }
};
