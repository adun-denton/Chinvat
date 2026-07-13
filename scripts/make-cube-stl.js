// Writes a manifold 20mm binary-STL cube. Usage: node make-cube-stl.js <out.stl>
const fs = require('fs');
const S = 20;
const v = [[0,0,0],[S,0,0],[S,S,0],[0,S,0],[0,0,S],[S,0,S],[S,S,S],[0,S,S]];
const faces = [ // 12 tris, outward CCW
  [0,2,1],[0,3,2], [4,5,6],[4,6,7], [0,1,5],[0,5,4],
  [1,2,6],[1,6,5], [2,3,7],[2,7,6], [3,0,4],[3,4,7],
];
const buf = Buffer.alloc(84 + faces.length * 50);
buf.write('chinvat calibration cube', 0);
buf.writeUInt32LE(faces.length, 80);
faces.forEach((f, i) => {
  const o = 84 + i * 50;
  const [a, b, c] = f.map((k) => v[k]);
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], w = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
  const len = Math.hypot(...n) || 1;
  [n[0]/len, n[1]/len, n[2]/len, ...a, ...b, ...c].forEach((x, j) => buf.writeFloatLE(x, o + j * 4));
});
fs.writeFileSync(process.argv[2], buf);
console.log(`OK: cube written (${buf.length} bytes)`);
