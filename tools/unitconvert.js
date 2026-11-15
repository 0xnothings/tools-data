// unitconvert.js — unit conversion across length, mass, volume, temperature, pressure, energy, data, time.
// Copyright (c) 2026 0xnothings
// @tool unitconvert
// @desc Convert values between units across 14 categories with exact factor tables and a unit lister
// @usage node tools/unitconvert.js 100 km mi --json
// @tags data,units,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `unitconvert — unit conversion

  node tools/unitconvert.js <value> <from> <to> [options]
  node tools/unitconvert.js --list [category]
  node tools/unitconvert.js --file values.txt --from km --to mi

  --list [cat]     list every unit (or one category)
  --file <path>    convert every number in a file/stdin (one per line)
  --from <unit>    default source unit for --file
  --to <unit>      default target unit for --file
  --precision <n>  significant digits (default 10)
  --exact          print raw factor arithmetic instead of a rounded value
  --json           machine-readable output
  -h, --help       this text

  Categories: length, mass, volume, area, temperature, pressure, energy, power,
  force, speed, data, datarate, time, angle, fuel. Temperature uses offset
  formulas (not ratios), everything else uses exact factors defined against the
  SI base unit. Unit names are matched case-insensitively, with aliases
  ("m", "metre", "meter", "metres" all resolve).`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const CATS = {
  length: {
    base: 'm',
    units: {
      m: ['meter', 'metre', 'meters', 'metres'], km: ['kilometer', 'kilometre', 'kilometers', 'kilometres'], cm: ['centimeter', 'centimetre', 'centimeters'], mm: ['millimeter', 'millimetre', 'millimeters'],
      um: ['micrometer', 'micron', 'microns'], nm: ['nanometer', 'nanometre'], in: ['inch', 'inches', '"'], ft: ['foot', 'feet', "'"], yd: ['yard', 'yards'],
      mi: ['mile', 'miles'], nmi: ['nauticalmile', 'nautical-mile'], ly: ['lightyear', 'light-year'], au: ['astronomicalunit'], pc: ['parsec', 'parsecs'],
      furlong: ['furlongs'], fathom: ['fathoms'], angstrom: ['angstroms'], pt: ['point'],
    },
    f: { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852, ly: 9.4607304725808e15, au: 149597870700, pc: 3.0856775814913673e16, furlong: 201.168, fathom: 1.8288, angstrom: 1e-10, pt: 0.0254 / 72 },
  },
  mass: {
    base: 'kg',
    units: { kg: ['kilogram', 'kilograms', 'kilo', 'kilos'], g: ['gram', 'grams'], mg: ['milligram', 'milligrams'], ug: ['microgram', 'micrograms'], t: ['tonne', 'tonnes', 'metricton'], lb: ['pound', 'pounds', 'lbs'], oz: ['ounce', 'ounces'], st: ['stone', 'stones'], ton: ['shortton', 'uston'], lton: ['longton'], ct: ['carat', 'carats'], gr: ['grain', 'grains'], slug: ['slugs'], amu: ['dalton', 'daltons'] },
    f: { kg: 1, g: 0.001, mg: 1e-6, ug: 1e-9, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318, ton: 907.18474, lton: 1016.0469088, ct: 0.0002, gr: 6.479891e-5, slug: 14.5939029372, amu: 1.66053906660e-27 },
  },
  volume: {
    base: 'l',
    units: { l: ['liter', 'litre', 'liters', 'litres'], ml: ['milliliter', 'millilitre'], cl: ['centiliter'], dl: ['deciliter'], m3: ['cubicmeter', 'cubicmetre'], cm3: ['cc', 'cubiccentimeter'], gal: ['gallon', 'gallons', 'usgal'], galuk: ['imperialgallon'], qt: ['quart', 'quarts'], pt: ['pint', 'pints'], cup: ['cups'], floz: ['fluidounce', 'fl-oz'], tbsp: ['tablespoon', 'tablespoons'], tsp: ['teaspoon', 'teaspoons'], bbl: ['barrel', 'barrels'], ft3: ['cubicfoot'], in3: ['cubicinch'], yd3: ['cubicyard'] },
    f: { l: 1, ml: 0.001, cl: 0.01, dl: 0.1, m3: 1000, cm3: 0.001, gal: 3.785411784, galuk: 4.54609, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, tbsp: 0.01478676478, tsp: 0.00492892159, bbl: 158.987294928, ft3: 28.316846592, in3: 0.016387064, yd3: 764.554857984 },
  },
  area: {
    base: 'm2',
    units: { m2: ['squaremeter', 'sqm'], km2: ['squarekilometer', 'sqkm'], cm2: ['squarecentimeter'], mm2: ['squaremillimeter'], ha: ['hectare', 'hectares'], acre: ['acres'], ft2: ['squarefoot', 'sqft'], in2: ['squareinch', 'sqin'], yd2: ['squareyard', 'sqyd'], mi2: ['squaremile', 'sqmi'] },
    f: { m2: 1, km2: 1e6, cm2: 1e-4, mm2: 1e-6, ha: 10000, acre: 4046.8564224, ft2: 0.09290304, in2: 0.00064516, yd2: 0.83612736, mi2: 2589988.110336 },
  },
  temperature: { base: 'c', units: { celsius: ['c', 'centigrade', '°c', 'degc'], fahrenheit: ['f', '°f', 'degf'], kelvin: ['k', '°k', 'degk'], rankine: ['r', '°r'], reaumur: ['re'], delisle: ['de'] }, special: true },
  pressure: {
    base: 'pa',
    units: { pa: ['pascal', 'pascals'], kpa: ['kilopascal'], mpa: ['megapascal'], hpa: ['hectopascal'], bar: ['bars'], mbar: ['millibar'], atm: ['atmosphere', 'atmospheres'], psi: ['poundsperquareinch'], torr: ['torrs'], mmhg: ['millimeterofmercury'], inhg: ['inchofmercury'], mmh2o: ['millimeterofwater'] },
    f: { pa: 1, kpa: 1000, mpa: 1e6, hpa: 100, bar: 100000, mbar: 100, atm: 101325, psi: 6894.757293168, torr: 133.322368421, mmhg: 133.322387415, inhg: 3386.389, mmh2o: 9.80665 },
  },
  energy: {
    base: 'j',
    units: { j: ['joule', 'joules'], kj: ['kilojoule'], mj: ['megajoule'], gj: ['gigajoule'], cal: ['calorie', 'calories'], kcal: ['kilocalorie', 'kilocalories', 'foodcalorie'], wh: ['watthour'], kwh: ['kilowatthour', 'kilowatt-hour'], mwh: ['megawatthour'], btu: ['btus'], therm: ['therms'], erg: ['ergs'], ev: ['electronvolt'], tnt: ['tonoftnt'], ftlb: ['footpound'] },
    f: { j: 1, kj: 1000, mj: 1e6, gj: 1e9, cal: 4.184, kcal: 4184, wh: 3600, kwh: 3600000, mwh: 3.6e9, btu: 1055.05585262, therm: 1.05505585262e8, erg: 1e-7, ev: 1.602176634e-19, tnt: 4.184e9, ftlb: 1.3558179483314004 },
  },
  power: {
    base: 'w',
    units: { w: ['watt', 'watts'], kw: ['kilowatt'], mw: ['megawatt'], gw: ['gigawatt'], hp: ['horsepower', 'horsepowers'], hpmetric: ['metrichorsepower'], btuh: ['bthuperhour'], tonref: ['tonofrefrigeration'], dbm: ['dbm'] },
    f: { w: 1, kw: 1000, mw: 1e6, gw: 1e9, hp: 745.6998715822702, hpmetric: 735.49875, btuh: 0.29307107017222, tonref: 3516.8528420667, dbm: 0.001 },
  },
  force: { base: 'n', units: { n: ['newton', 'newtons'], kn: ['kilonewton'], dyn: ['dyne', 'dynes'], lbf: ['poundforce'], kgf: ['kilogramforce'], pdl: ['poundal'] }, f: { n: 1, kn: 1000, dyn: 1e-5, lbf: 4.4482216152605, kgf: 9.80665, pdl: 0.138254954376 } },
  speed: {
    base: 'mps',
    units: { mps: ['m/s', 'meterspersecond'], kph: ['km/h', 'kmh', 'kilometersperhour'], mph: ['mi/h', 'milesperhour'], knot: ['kn', 'knots'], fps: ['ft/s', 'feetpersecond'], mach: ['machs'], lightspeed: ['speedoflight', 'light'] },
    f: { mps: 1, kph: 1 / 3.6, mph: 0.44704, knot: 0.514444444444, fps: 0.3048, mach: 340.29, lightspeed: 299792458 },
  },
  data: {
    base: 'b',
    units: { b: ['byte', 'bytes'], kb: ['kilobyte'], mb: ['megabyte'], gb: ['gigabyte'], tb: ['terabyte'], pb: ['petabyte'], eb: ['exabyte'], kib: ['kibibyte'], mib: ['mebibyte'], gib: ['gibibyte'], tib: ['tebibyte'], pib: ['pebibyte'], bit: ['bits'], kbit: ['kilobit'], mbit: ['megabit'], gbit: ['gigabit'], tbit: ['terabit'], sector: ['sectors'], block: ['blocks512'], floppy: ['floppy144'] },
    f: { b: 1, kb: 1000, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, eb: 1e18, kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776, pib: 1125899906842624, bit: 0.125, kbit: 125, mbit: 125000, gbit: 125000000, tbit: 125000000000, sector: 512, block: 512, floppy: 1474560 },
  },
  datarate: {
    base: 'bps',
    units: { bps: ['bit/s', 'bitspersecond'], kbps: ['kbit/s'], mbps: ['mbit/s'], gbps: ['gbit/s'], tbps: ['tbit/s'], 'kb/s': ['kilobytepersecond', 'kBs'], 'mb/s': ['megabytepersecond', 'MBs'], 'gb/s': ['gigabytepersecond', 'GBs'] },
    f: { bps: 1, kbps: 1000, mbps: 1e6, gbps: 1e9, tbps: 1e12, 'kb/s': 8000, 'mb/s': 8e6, 'gb/s': 8e9 },
  },
  time: {
    base: 's',
    units: { s: ['sec', 'secs', 'second', 'seconds'], ms: ['millisecond', 'milliseconds'], us: ['microsecond', 'microseconds'], ns: ['nanosecond'], min: ['minute', 'minutes'], h: ['hr', 'hrs', 'hour', 'hours'], d: ['day', 'days'], wk: ['week', 'weeks'], mo: ['month', 'months', 'gregorianmonth'], yr: ['year', 'years', 'gregorianyear'], decade: ['decades'], century: ['centuries'], fortnight: ['fortnights'] },
    f: { s: 1, ms: 0.001, us: 1e-6, ns: 1e-9, min: 60, h: 3600, d: 86400, wk: 604800, mo: 2629746, yr: 31556952, decade: 315569520, century: 3155695200, fortnight: 1209600 },
  },
  angle: { base: 'rad', units: { rad: ['radian', 'radians'], deg: ['degree', 'degrees', '°'], grad: ['gradian', 'gradians'], turn: ['turns', 'revolution', 'rev'], arcmin: ['arcminute'], arcsec: ['arcsecond'], mrad: ['milliradian'] }, f: { rad: 1, deg: Math.PI / 180, grad: Math.PI / 200, turn: Math.PI * 2, arcmin: Math.PI / 10800, arcsec: Math.PI / 648000, mrad: 0.001 } },
  fuel: { base: 'lper100km', units: { lper100km: ['l/100km'], kmpl: ['km/l'], mpgus: ['mpgus', 'mpg'], mpguk: ['mpguk', 'imperialmpg'] }, inverse: true, f: { lper100km: 1, kmpl: 100, mpgus: 235.214583, mpguk: 282.481 } },
};

const ALIAS = new Map();
const AMBIGUOUS = new Map();
let aliasCount = 0;
for (const [cat, def] of Object.entries(CATS)) {
  for (const [unit, names] of Object.entries(def.units)) {
    const keys = [unit, ...names];
    for (const k of keys) {
      const norm = String(k).toLowerCase().replace(/\s+/g, '');
      if (ALIAS.has(norm) && (ALIAS.get(norm).cat !== cat || ALIAS.get(norm).unit !== unit)) {
        const prev = ALIAS.get(norm);
        if (!AMBIGUOUS.has(norm)) AMBIGUOUS.set(norm, [prev]);
        AMBIGUOUS.get(norm).push({ cat, unit });
      }
      ALIAS.set(norm, { cat, unit });
      aliasCount++;
    }
  }
}

const resolve = (name) => {
  const key = String(name).toLowerCase().replace(/\s+/g, '');
  if (ALIAS.has(key)) return ALIAS.get(key);
  return null;
};

const listArg = get(o, 'list', null);
if (flag(o, 'list') || typeof listArg === 'string') {
  const only = typeof listArg === 'string' ? listArg : get(o, 'list', null);
  const catName = typeof only === 'string' ? only.toLowerCase() : (o._[0] || '').toLowerCase();
  const cats = catName && CATS[catName] ? { [catName]: CATS[catName] } : CATS;
  if (catName && !CATS[catName]) die(`unknown category "${catName}" — try: ${Object.keys(CATS).join(', ')}`);
  if (flag(o, 'json')) {
    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(cats).map(([c, d]) => [c, { base: d.base, units: Object.keys(d.units) }])), null, 2) + '\n');
  } else {
    for (const [c, d] of Object.entries(cats)) {
      console.log(`\n${c.toUpperCase()}  (SI base: ${d.base})`);
      console.log(table(Object.entries(d.units).map(([u, names]) => ({ unit: u, factor: d.special ? '(formula)' : d.f[u] !== undefined ? String(d.f[u]) : 'n/a', aliases: names.join(', ') })), ['unit', 'factor', 'aliases']));
    }
    if (AMBIGUOUS.size) console.log(`\n${AMBIGUOUS.size} ambiguous alias(es) resolved to the last definition: ${[...AMBIGUOUS.keys()].join(', ')}`);
  }
  process.exit(0);
}

const tempTo = (v, from, to) => {
  const k = from === 'celsius' ? v + 273.15 : from === 'fahrenheit' ? (v + 459.67) * 5 / 9 : from === 'kelvin' ? v : from === 'rankine' ? v * 5 / 9 : from === 'reaumur' ? v * 1.25 + 273.15 : from === 'delisle' ? 373.15 - v * (2 / 3) : NaN;
  return to === 'celsius' ? k - 273.15 : to === 'fahrenheit' ? k * 9 / 5 - 459.67 : to === 'kelvin' ? k : to === 'rankine' ? k * 9 / 5 : to === 'reaumur' ? (k - 273.15) * 0.8 : to === 'delisle' ? (373.15 - k) * 1.5 : NaN;
};

// fuel economy is reciprocal, so it gets its own pair of functions against km/l
const FUEL_TO_KMPL = { lper100km: (v) => (v === 0 ? Infinity : 100 / v), kmpl: (v) => v, mpgus: (v) => v * 2.35214583, mpguk: (v) => v * 2.824809 };
const FUEL_FROM_KMPL = { lper100km: (v) => (v === 0 ? Infinity : 100 / v), kmpl: (v) => v, mpgus: (v) => v / 2.35214583, mpguk: (v) => v / 2.824809 };

function convert(value, fromRaw, toRaw) {
  const f = resolve(fromRaw), t = resolve(toRaw);
  if (!f) die(`unknown unit "${fromRaw}" — run with --list to see them`);
  if (!t) die(`unknown unit "${toRaw}" — run with --list to see them`);
  if (f.cat !== t.cat) die(`cannot convert ${f.cat} to ${t.cat} (${fromRaw} -> ${toRaw})`);
  const def = CATS[f.cat];
  let out;
  if (def.special && f.cat === 'temperature') out = tempTo(value, f.unit, t.unit);
  else if (def.inverse) out = FUEL_FROM_KMPL[t.unit](FUEL_TO_KMPL[f.unit](value));
  else out = (value * def.f[f.unit]) / def.f[t.unit];
  const isFormula = (def.special && f.cat === 'temperature') || !!def.inverse;
  return {
    value: out, from: f, to: t, formulaMode: isFormula,
    factor: isFormula ? null : def.f[f.unit] / def.f[t.unit],
  };
}

const precision = num(get(o, 'precision', 10), 10);
const sig = (v) => {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e16) return String(Number(v.toPrecision(precision)));
  return v.toExponential(Math.max(1, precision - 1)).replace('e', 'e');
};

const fileArg = get(o, 'file', null);
const fromArg = get(o, 'from', null);
const toArg = get(o, 'to', null);

const results = [];
if (fileArg !== null || (o._.length === 1 && fromArg && toArg)) {
  const path = fileArg !== null ? String(fileArg) : o._[0];
  if (!fromArg || !toArg) die('--file needs --from <unit> --to <unit>');
  const text = path === '-' || !path ? await readInput(null) : readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const nums = t.split(/[\s,;]+/).filter(Boolean).map((x) => Number(x)).filter(Number.isFinite);
    for (const v of nums) {
      const r = convert(v, String(fromArg), String(toArg));
      results.push({ input: v, output: Number(sig(r.value)), from: r.from.unit, to: r.to.unit });
    }
  }
} else {
  const v = num(o._[0], NaN);
  if (!Number.isFinite(v)) die(`first argument must be a number, got "${o._[0] ?? ''}"`);
  const [from, to] = [o._[1], o._[2]];
  if (!from || !to) die('need <value> <from> <to> — e.g. node tools/unitconvert.js 100 km mi');
  const r = convert(v, from, to);
  results.push({ input: v, output: Number(sig(r.value)), from: r.from.unit, to: r.to.unit, raw: sig(r.value) });
}

const grouped = results.reduce((m, r) => { const k = `${r.from}->${r.to}`; if (!m[k]) m[k] = []; m[k].push(r); return m; }, {});

if (flag(o, 'json')) process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : { count: results.length, conversions: results, categories: grouped }, null, 2) + '\n');
else if (results.length === 1) {
  const r = results[0];
  const c = resolve(r.from);
  const d = CATS[c.cat];
  const factorStr = d.special || d.inverse ? '(formula, not a ratio)' : String(d.f[r.from] / d.f[r.to]);
  console.log(table([
    { field: 'input', value: `${fmt(r.input)} ${r.from}` },
    { field: 'output', value: `${fmt(r.output)} ${r.to}` },
    { field: 'category', value: c.cat },
    { field: 'factor', value: factorStr },
    { field: 'raw result', value: String(r.raw) },
  ], ['field', 'value']));
} else {
  console.log(table(results.map((r) => ({ input: fmt(r.input), from: r.from, output: fmt(r.output), to: r.to })), ['input', 'from', 'output', 'to']));
  console.log(`\n${results.length} conversion(s)`);
}
