// Generates app icons (PNG/ICO/ICNS) from ../logo.png using only Node built-ins.
// No external image libraries required.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(ROOT, '..', 'logo.png');

function readPNG(buf) {
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  // Unfilter scanlines.
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pred) & 0xff;
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

function nearestColorSample(src, sx, sy, sw, sh, dw, dh) {
  // Returns a new {width,height,channels,data} downscaled to dw x dh (simple box average).
  const { width, height, channels, data } = src;
  const out = Buffer.alloc(dw * dh * channels);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * sw) / dw));
      const acc = new Array(channels).fill(0);
      let n = 0;
      for (let j = sy0; j < sy1; j++) {
        for (let i = sx0; i < sx1; i++) {
          const si = (j * width + i) * channels;
          for (let c = 0; c < channels; c++) acc[c] += data[si + c];
          n++;
        }
      }
      const oi = (y * dw + x) * channels;
      for (let c = 0; c < channels; c++) out[oi + c] = Math.round(acc[c] / n);
    }
  }
  return { width: dw, height: dh, channels, data: out };
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(img) {
  const { width, height, channels, data } = img;
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // Add filter byte per scanline.
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeICO(images) {
  // images: array of {width,height,channels,data} (RGBA). Max 256.
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(count * 16);
  const pngs = images.map(encodePNG);
  let offset = 6 + count * 16;
  images.forEach((img, i) => {
    const w = img.width >= 256 ? 0 : img.width;
    const h = img.height >= 256 ? 0 : img.height;
    entries[i * 16] = w;
    entries[i * 16 + 1] = h;
    entries[i * 16 + 2] = 0; // palette
    entries[i * 16 + 3] = 0;
    entries[i * 16 + 4] = 1; // planes
    entries[i * 16 + 5] = 32; // bpp
    entries[i * 16 + 6] = pngs[i].length & 0xff;
    entries[i * 16 + 7] = (pngs[i].length >>> 8) & 0xff;
    entries[i * 16 + 8] = (pngs[i].length >>> 16) & 0xff;
    entries[i * 16 + 9] = (pngs[i].length >>> 24) & 0xff;
    entries[i * 16 + 10] = offset & 0xff;
    entries[i * 16 + 11] = (offset >>> 8) & 0xff;
    entries[i * 16 + 12] = (offset >>> 16) & 0xff;
    entries[i * 16 + 13] = (offset >>> 24) & 0xff;
    offset += pngs[i].length;
  });
  return Buffer.concat([header, entries, ...pngs]);
}

function encodeICNS(images) {
  // Use PNG-embedded icons (icXX / il32 / is32 fallback). Prefer PNG OS types.
  const parts = [];
  const add = (osType, buf) => {
    const t = Buffer.from(osType, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length + 8, 0);
    parts.push(Buffer.concat([t, len, buf]));
  };
  const bySize = {};
  for (const img of images) bySize[img.width] = img;
  const want = { 1024: 'ic10', 512: 'ic09', 256: 'ic08', 128: 'ic07' };
  for (const size of [1024, 512, 256, 128]) {
    if (bySize[size]) add(want[size], encodePNG(bySize[size]));
  }
  const header = Buffer.from('icns', 'ascii');
  const total = Buffer.alloc(4);
  const body = Buffer.concat(parts);
  total.writeUInt32BE(body.length + 8, 0);
  return Buffer.concat([header, total, body]);
}

function toRGBA(img) {
  if (img.channels === 4) return img;
  const out = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.channels === 3) {
      out[i * 4] = img.data[i * 3];
      out[i * 4 + 1] = img.data[i * 3 + 1];
      out[i * 4 + 2] = img.data[i * 3 + 2];
      out[i * 4 + 3] = 255;
    } else {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = img.data[i];
      out[i * 4 + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, channels: 4, data: out };
}

function main() {
  const src = toRGBA(readPNG(fs.readFileSync(SRC)));
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  const scaled = sizes.map((s) => nearestColorSample(src, 0, 0, src.width, src.height, s, s));

  // build/icon.png (512x512 for linux icon dir)
  fs.mkdirSync(path.resolve(ROOT, 'build'), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, 'build', 'icon.png'), encodePNG(bySize(scaled, 512)));
  // art/icon.png
  fs.mkdirSync(path.resolve(ROOT, 'art'), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, 'art', 'icon.png'), encodePNG(bySize(scaled, 512)));
  // build/512x512.png
  fs.writeFileSync(path.resolve(ROOT, 'build', '512x512.png'), encodePNG(bySize(scaled, 512)));
  // build/icon.ico
  fs.writeFileSync(path.resolve(ROOT, 'build', 'icon.ico'), encodeICO([16, 32, 48, 64, 128, 256].map((s) => bySize(scaled, s))));
  // build/icon.icns
  fs.writeFileSync(path.resolve(ROOT, 'build', 'icon.icns'), encodeICNS(scaled));
  // installerSidebar.bmp replacement: write a 164x314 PNG as build/installerSidebar.bmp is bmp; skip, keep existing.
  console.log('Icons generated.');
}

function bySize(arr, s) {
  return arr.find((i) => i.width === s) || arr[arr.length - 1];
}

main();
