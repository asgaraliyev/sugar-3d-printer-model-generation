// Printers + per-print settings.
// Foodbot: Cura profile embedded in models/*.gcode (;CURA_PROFILE_STRING), 0.8 mm rules and
// material notes from foodbot/*.pdf and foodbot/Ingredient .docx.
// Candy sugar machine: copied from 664430.png.stl.*.gcode (iceman3d SteamEngine), which prints on it.

export const PRINTERS = {
  foodbot: {
    label: 'Foodbot',
    dialect: 'cura15',
    centerX: 100, centerY: 100,       // bed 200 x 200
    maxX: 150, maxY: 150, maxZ: 100,  // largest model (Foodbot cura instruction.pdf)
    filamentDiameter: 28,             // syringe, filament_diameter: 28
    nozzles: [0.6, 0.8],
    defaultMaterial: 'default',
  },
  candy: {
    label: 'Şəkər maşını (candy)',
    dialect: 'iceman',
    // From the 24 factory files in the printer's gcodes/general/: most centre on X100 Y280,
    // the largest are 130 wide and 145 tall.
    centerX: 100, centerY: 280,
    maxX: 130, maxY: 145, maxZ: 2,
    filamentDiameter: 3.7,
    nozzles: [1.33],
    defaultMaterial: 'candySugar',
    flat: true,                       // one layer; an STL is cut once at half its height
  },
};

export const printerOf = (s) => PRINTERS[s.printer];

// Values that follow the nozzle.
export function nozzleDefaults(printer, nozzle, fillDensity) {
  if (printer === 'candy') {
    return { layerHeight: 2, firstLayer: 2, wallThickness: 1.33, solidThickness: 0 };
  }
  if (nozzle === 0.8) { // PDF rules, layer depends on fill
    const layerHeight = fillDensity > 50 ? 0.75 : 0.7;
    return { layerHeight, firstLayer: layerHeight, wallThickness: 1.6, solidThickness: +(layerHeight * 3).toFixed(2) };
  }
  return { layerHeight: 0.45, firstLayer: 0.4, wallThickness: 1.2, solidThickness: 1.2 };
}

export function defaultSettings(printer = 'foodbot') {
  if (printer === 'candy') {
    // One outline at 50 mm/s: the newer factory files run all moves at F3000 (the example file's
    // F6600 was too fast). 135 ℃ is what the machine's own screen heats to before a print.
    return {
      printer, material: 'candySugar', nozzle: 1.33,
      ...nozzleDefaults(printer, 1.33, 0),
      fillDensity: 0, fillOverlap: 0,
      printSpeed: 50, firstLayerSpeed: 50, travelSpeed: 50,
      temp: 135, startDwell: 3, loopDwell: 0.5, endDwell: 5,
      retractAmount: 0, retractSpeed: 20, retractMinTravel: 1.5,
      brim: false, brimLines: 5,
    };
  }
  return {
    printer,
    material: 'default',
    nozzle: 0.6,
    ...nozzleDefaults(printer, 0.6, 20),
    fillDensity: 20,      // %
    fillOverlap: 15,      // % of a line width
    printSpeed: 15,       // mm/s, all Cura speeds are 15 (F900)
    firstLayerSpeed: 15,
    travelSpeed: 15,
    retractAmount: 2,     // mm
    retractSpeed: 50,     // mm/s (F3000)
    retractMinTravel: 1.5,
    brim: false,
    brimLines: 5,
  };
}

// nozzle: null keeps the current one. speed: share of the printer's default print speed.
export const MATERIALS = {
  default: { printer: 'foodbot', label: 'Standart (profil)', nozzle: 0.6, speed: 1, note: '' },
  realChocolate: {
    printer: 'foodbot', label: 'Əsl şokolad', nozzle: 0.6, speed: 0.8,
    note: 'Metal başlıq 20#. Printerdə 31–33℃. Çox yumşaqdırsa sürəti 50–60%-ə endirin.',
  },
  compoundChocolate: {
    printer: 'foodbot', label: 'Kompound şokolad', nozzle: null, speed: 1,
    note: 'Metal başlıq 18# (0.8) və ya 20# (0.6). Printerdə 32–34℃, bəziləri 35–37℃.',
  },
  creamyCandy: {
    printer: 'foodbot', label: 'Kremli konfet', nozzle: 0.8, speed: 1,
    note: 'Plastik başlıq. Qışda 35℃, digər fəsillərdə adətən qızdırmaq lazım deyil.',
  },
  cheese: {
    printer: 'foodbot', label: 'Pendir', nozzle: 0.8, speed: 1,
    note: 'Plastik başlıq, qızdırmaq lazım deyil. Hava qabarcığı olmasın deyə şprisin ağzına 2 sm qalmış doldurun.',
  },
  potato: { printer: 'foodbot', label: 'Kartof püresi', nozzle: 0.8, speed: 1, note: 'Plastik başlıq, qızdırmaq lazım deyil.' },
  jam: {
    printer: 'foodbot', label: 'Cem', nozzle: 0.8, speed: 1, flatOnly: true,
    note: 'Plastik başlıq, qızdırmaq lazım deyil. Yalnız düz (2D) model.',
  },
  biscuit: {
    printer: 'foodbot', label: 'Peçenye', nozzle: 0.8, speed: 1, flatOnly: true,
    note: 'Plastik başlıq, qızdırmaq lazım deyil. Yalnız düz (2D) model, çapdan sonra bişirilir.',
  },
  candySugar: {
    printer: 'candy', label: 'Şəkər (candy)', nozzle: 1.33, speed: 1,
    note: 'Bir qat, yalnız kontur xətti — nümunə fayldakı kimi.',
  },
};

export function applyNozzle(s, nozzle) {
  return { ...s, nozzle, ...nozzleDefaults(s.printer, nozzle, s.fillDensity) };
}

export function applyMaterial(s, key) {
  const m = MATERIALS[key];
  const base = defaultSettings(s.printer);
  const next = applyNozzle({ ...s, material: key }, m.nozzle ?? s.nozzle);
  next.printSpeed = +(base.printSpeed * m.speed).toFixed(1);
  return next;
}

// Each printer keeps its own last settings.
const STORAGE_KEY = 'foodbot.settings.v2';

function readStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === 'object') return saved;
  } catch { /* storage unavailable */ }
  return {};
}

export function loadSettings(printer) {
  const store = readStore();
  const key = PRINTERS[printer] ? printer : PRINTERS[store.printer] ? store.printer : 'foodbot';
  const base = defaultSettings(key);
  const saved = store.byPrinter?.[key];
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(base)) {
      if (k !== 'printer' && typeof saved[k] === typeof base[k]) base[k] = saved[k];
    }
  }
  if (MATERIALS[base.material]?.printer !== key) base.material = PRINTERS[key].defaultMaterial;
  if (!PRINTERS[key].nozzles.includes(base.nozzle)) base.nozzle = PRINTERS[key].nozzles[0];
  return base;
}

export function saveSettings(s) {
  const store = readStore();
  store.printer = s.printer;
  store.byPrinter = { ...store.byPrinter, [s.printer]: s };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
}
