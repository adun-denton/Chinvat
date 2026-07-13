// Scales a binary STL's vertices in place (normals untouched).
// Usage: node scale-stl.js <in.stl> <out.stl> <factor>
const fs = require('fs');
const [, , inPath, outPath, factorStr] = process.argv;
const factor = Number(factorStr);
const buf = fs.readFileSync(inPath);
const n = buf.readUInt32LE(80);
if (84 + n * 50 !== buf.length) { console.error(`FAIL: not binary STL or corrupt (tris=${n}, len=${buf.length})`); process.exit(1); }
for (let i = 0; i < n; i++) {
  const base = 84 + i * 50 + 12; // skip normal (12 bytes)
  for (let v = 0; v < 9; v++) {
    const off = base + v * 4;
    buf.writeFloatLE(buf.readFloatLE(off) * factor, off);
  }
}
fs.writeFileSync(outPath, buf);
// report bounds
let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < n; i++) {
  const base = 84 + i * 50 + 12;
  for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
    const val = buf.readFloatLE(base + (v * 3 + a) * 4);
    if (val < min[a]) min[a] = val;
    if (val > max[a]) max[a] = val;
  }
}
console.log(`OK: ${n} tris, dims_mm = ${max.map((m, a) => (m - min[a]).toFixed(1)).join(' x ')}`);
