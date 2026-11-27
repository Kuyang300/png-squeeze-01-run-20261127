// png-squeeze-01-run-20261127 — lossless PNG re-encoder.
//
// Strategy: for each 1280x720 RGBA screenshot, try every exact form the
// checker reads (palette when <=256 colours, grey / grey+alpha when every
// pixel is grey, RGB / RGBA otherwise, plus the single-transparent-colour
// tRNS trick), filter every row with every choice (fixed 0-4, min-sum,
// fewest-distinct-pairs, and per-row brute force weighed by real deflate),
// screen each candidate with zlib level 6, then write the best with zlib
// level 9 (default and Z_FILTERED strategies, smallest wins). Pure Node 22
// stdlib, no network, no clock, no environment reads: the same input always
// writes the same bytes.
//
// Runs as: node /bot/main.ts   (reads /input/<id>/image.png, writes
// /output/<id>/image.png; MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override
// the two directories for local runs only — they never change the bytes).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CHUNK_TYPES = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function ascii(s) {
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

/** A PNG file of [type, data] chunks: signature, then each chunk with length + CRC. */
function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

/** IHDR data: width, height, bit depth 8, colour type, compression 0, filter 0, no interlace. */
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Row `cur` (stride samples, bpp bytes a pixel, `prev` the row above or null)
 * filtered by `type` into out[0, stride).
 */
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed (-128..127), absolute. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct pairs of neighbouring bytes a filtered row holds. */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/**
 * The image a PNG holds, as RGBA (4 bytes a pixel, rows top to bottom), or
 * throws when it is not a PNG the contest reads (bit depth 8, non-interlaced,
 * colour type 0/2/3/4/6, only IHDR/PLTE/tRNS/IDAT/IEND, CRCs correct).
 */
function decodePng(bytes) {
  const fail = (why) => {
    throw new Error(why);
  };
  if (!(bytes instanceof Uint8Array)) fail('not bytes');
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) fail('no PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) fail('bytes after IEND');
    if (at + 12 > bytes.length) fail('chunk cut short at ' + at);
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) fail('chunk claims bytes the file does not hold');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) fail('no chunk type at ' + at);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) fail(type + ' chunk fails its CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!CHUNK_TYPES.includes(type)) fail('holds a ' + type + ' chunk');
    if (header === null && type !== 'IHDR') fail('first chunk is ' + type + ', not IHDR');
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) fail('IHDR twice');
      if (len !== 13) fail('IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
      if (header.width === 0 || header.height === 0) fail('width or height is 0');
      if (header.depth !== 8) fail('bit depth is ' + header.depth + ', not 8');
      if (!Object.hasOwn(CHANNELS, header.colourType)) fail('colour type ' + header.colourType);
      if (data[10] !== 0 || data[11] !== 0) fail('compression or filter method is not 0');
      if (data[12] !== 0) fail('interlaced');
    } else if (type === 'PLTE') {
      if (palette !== null) fail('PLTE twice');
      if (header.colourType !== 3) fail('PLTE with colour type ' + header.colourType);
      if (idat.length > 0) fail('PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) fail('PLTE is not 1 to 256 entries');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) fail('tRNS twice');
      if (idat.length > 0) fail('tRNS follows IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) fail('tRNS comes before PLTE');
        if (len > palette.length / 3) fail('tRNS holds more entries than the palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) fail('tRNS is not ' + (ct === 0 ? 2 : 6) + ' bytes for colour type ' + ct);
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) fail('tRNS names a sample over 255');
      } else fail('tRNS with colour type ' + ct);
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) fail('IDAT chunks are not in a row');
      if (header.colourType === 3 && palette === null) fail('IDAT comes before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) fail('IEND is not empty');
      ended = true;
    }
  }
  if (!ended) fail('no IEND');
  if (idat.length === 0) fail('no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    fail('IDAT is not one whole zlib stream: ' + String(err && err.message).split('\n')[0]);
  }
  if (raw.length !== expected) fail('IDAT inflates to ' + raw.length + ' bytes, not ' + expected);

  // Unfilter in place, row by row.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) fail('row ' + y + ' has filter type ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) fail('pixel names palette entry ' + e + ' of ' + entries);
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

/** What the image holds: opaque?, grey?, and its colours when at most 256. */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else counts.set(key, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.entries()].map(([key, count]) => ({
        rgba: [(key >>> 24) & 0xff, (key >>> 16) & 0xff, (key >>> 8) & 0xff, key & 0xff],
        word: key,
        count,
      }));
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey or RGB) the image may key by tRNS
 * instead of an alpha channel: every pixel opaque or that exact value at
 * alpha 0, and no opaque pixel of the same value. Null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** A palette's entries in the order a trial writes them: transparent first (by alpha), then by `order`. */
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

/** The palette form: {plte, trns, indices}. */
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
    indices[i] = index.get(key);
  }
  return { plte, trns, indices };
}

/** How many bytes written before a row brute force compresses its trials after. */
const BRUTE_CONTEXT = 32768;
/** The zlib level brute force weighs a row's trials at. */
const BRUTE_LEVEL = 4;

/**
 * Every filter choice's raw data at once, one pass over the rows: the five
 * filtered trials of a row are computed once and shared by the fixed, minsum,
 * pairs and brute choices, so the filter arithmetic runs a single time.
 * `choices` holds fixed types (0-4) and/or 'minsum' | 'pairs' | 'brute'.
 * Returns one raw buffer per choice, in the same order.
 */
function filterAll(samples, width, height, bpp, choices) {
  const stride = width * bpp;
  const rowLen = stride + 1;
  const raws = choices.map(() => new Uint8Array(height * rowLen));
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(rowLen);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowLen;
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trial[t].subarray(1));
    for (let c = 0; c < choices.length; c++) {
      const choice = choices[c];
      let type;
      if (typeof choice === 'number') {
        type = choice;
      } else if (choice === 'minsum') {
        let best = Infinity;
        type = 0;
        for (let t = 0; t < 5; t++) {
          const s = signedSum(trial[t].subarray(1));
          if (s < best) {
            best = s;
            type = t;
          }
        }
      } else if (choice === 'pairs') {
        let best = Infinity;
        type = 0;
        for (let t = 0; t < 5; t++) {
          const s = pairsOf(trial[t].subarray(1), seen, ++stamp);
          if (s < best) {
            best = s;
            type = t;
          }
        }
      } else {
        // brute: each trial deflated at level 4 after the 32 KiB written before it; smallest kept.
        const before = raws[c].subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        let best = Infinity;
        type = 0;
        for (let t = 0; t < 5; t++) {
          const s = deflateSync(trial[t], { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
          if (s < best) {
            best = s;
            type = t;
          }
        }
      }
      raws[c].set(trial[type], at);
    }
  }
  return raws;
}

/** The filter choices each form is screened with. */
const FILTERS = {
  palette: [0, 'minsum', 'brute'],
  channels: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
};

/** The forms the image can be written in exactly: each {colourType, bpp, samples, plte, trns, filters}. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters: FILTERS.palette });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

/** The bytes a form's PLTE and tRNS chunks take in its file. */
function chunkBytes(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

/** The PNG of an image of `form` whose IDAT holds the zlib stream `idat`. */
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/**
 * The smallest PNG of the image: screen every form and filter choice with
 * zlib level 6, keep the two best, and write the smaller of their level-9
 * streams (default and Z_FILTERED strategies; the level-6 stream itself is
 * kept as a candidate too, in case level 9 ever loses).
 */
function squeeze(rgba, width, height) {
  const finalists = [];
  const consider = (form, data, zlib, total) => {
    const entry = { form, data, zlib, total };
    finalists.push(entry);
    finalists.sort((a, b) => a.total - b.total);
    if (finalists.length > 2) finalists.length = 2;
  };
  for (const form of formsOf(rgba)) {
    const raws = filterAll(form.samples, width, height, form.bpp, form.filters);
    const overhead = chunkBytes(form);
    for (let j = 0; j < form.filters.length; j++) {
      const zlib = deflateSync(raws[j], { level: 6, memLevel: 8 });
      consider(form, raws[j], zlib, zlib.length + overhead);
    }
  }
  let best = null;
  for (const f of finalists) {
    const candidates = [f.zlib];
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      candidates.push(deflateSync(f.data, { level: 9, memLevel: 9, strategy }));
    }
    for (const zlib of candidates) {
      const total = zlib.length + chunkBytes(f.form);
      if (best === null || total < best.total) best = { form: f.form, zlib, total };
    }
  }
  return pngOfForm(width, height, best.form, best.zlib);
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
