// Generates simple gradient "paper plane" PNG icons with no dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const inTri = (x, y, a, b, c) => {
    const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
    const p = [x, y], d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const S = size;
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      const o = y * (S * 4 + 1) + 1 + x * 4;
      const r = Math.hypot(x - S / 2, y - S / 2), R = S / 2;
      const inside = r < R * 0.98 || (Math.abs(x - S / 2) < R * 0.85 && Math.abs(y - S / 2) < R * 0.85 && r < R * 1.1);
      const t = (x + y) / (2 * S);
      let px = [Math.round(109 + 40 * t), Math.round(94 - 20 * t), Math.round(252 - 30 * t), inside ? 255 : 0];
      const plane = inTri(x, y, [S * 0.2, S * 0.5], [S * 0.8, S * 0.25], [S * 0.5, S * 0.8]);
      const notch = inTri(x, y, [S * 0.42, S * 0.55], [S * 0.8, S * 0.25], [S * 0.5, S * 0.8]);
      if (inside && plane && !notch) px = [255, 255, 255, 255];
      raw.set(px, o);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.mkdirSync('public/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(`public/icons/${s}.png`, png(s));
console.log('icons written');
