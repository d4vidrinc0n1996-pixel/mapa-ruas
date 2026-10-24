// Genera los iconos PNG de la PWA (mismo diseño que icons/icon.svg) sin dependencias.
// Uso: npm run icons

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Funciones de distancia con signo, en unidades del diseño de 512 px.
const sdCircleRing = (x, y, cx, cy, r, halfWidth) => Math.abs(Math.hypot(x - cx, y - cy) - r) - halfWidth;

function sdRoundRect(x, y, cx, cy, half, r) {
  const qx = Math.abs(x - cx) - half + r;
  const qy = Math.abs(y - cy) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(x, y, ax, ay, bx, by, halfWidth) {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - halfWidth;
}

const BG = [15, 23, 42];
const GREEN = [34, 197, 94];
const WHITE = [255, 255, 255];
const ROTORS = [[172, 172], [340, 172], [172, 340], [340, 340]];

function render(size, { fullBleed = false, scale = 1 } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const px = 512 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const X = (i + 0.5) * px;
      const Y = (j + 0.5) * px;
      const coverage = (d, unit) => Math.max(0, Math.min(1, 0.5 - d / unit));

      // Color premultiplicado, compuesto capa sobre capa.
      let [r, g, b, a] = [0, 0, 0, 0];
      const over = (color, alpha) => {
        r = color[0] * alpha + r * (1 - alpha);
        g = color[1] * alpha + g * (1 - alpha);
        b = color[2] * alpha + b * (1 - alpha);
        a = alpha + a * (1 - alpha);
      };

      over(BG, fullBleed ? 1 : coverage(sdRoundRect(X, Y, 256, 256, 256, 96), px));

      const U = 256 + (X - 256) / scale;
      const V = 256 + (Y - 256) / scale;
      const unit = px / scale;
      over(GREEN, coverage(sdCircleRing(U, V, 256, 256, 196, 10), unit));

      let white = Math.min(
        sdSegment(U, V, 172, 172, 340, 340, 11),
        sdSegment(U, V, 340, 172, 172, 340, 11),
        sdRoundRect(U, V, 256, 256, 34, 16),
      );
      for (const [cx, cy] of ROTORS) white = Math.min(white, sdCircleRing(U, V, cx, cy, 48, 8));
      over(WHITE, coverage(white, unit));

      const o = (j * size + i) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, out);
}

const dir = new URL('../icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', dir), render(192));
writeFileSync(new URL('icon-512.png', dir), render(512));
writeFileSync(new URL('maskable-512.png', dir), render(512, { fullBleed: true, scale: 0.72 }));
writeFileSync(new URL('apple-touch-icon.png', dir), render(180, { fullBleed: true, scale: 0.85 }));
console.log('Iconos generados en icons/');
