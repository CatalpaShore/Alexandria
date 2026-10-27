import { deflateSync } from "node:zlib";

// Original procedural landscape, no fonts, photographs, URLs or external assets.
const palettes = [[50,83,99],[64,91,72],[46,49,74],[99,66,61],[35,72,54],[86,65,50]];
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, checksum]);
}
export function createDemoPoster(index) {
  const width = 480, height = 680, raw = Buffer.alloc((width * 3 + 1) * height), palette = palettes[index % palettes.length];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sun = Math.hypot(x - (140 + index % 4 * 46), y - 210) < 92;
    const mountain = y > 505 - 170 * Math.sin(x / 170 + index * .4);
    const foreground = y > 580 - 75 * Math.cos(x / 100 + index);
    const fade = .35 + .65 * (1 - y / height);
    const color = foreground ? [31,37,38] : mountain ? palette.map(v => v * .46) : sun ? [212,185,131] : palette.map(v => v * fade + 12);
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    for (let c = 0; c < 3; c++) raw[offset + c] = Math.round(color[c]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
