/* 临时诊断：输出版面分析结果与坐标框，供叠加图核对 */
'use strict';
const fs = require('fs');
const { analyzePdf } = require('../server/pdflayout.js');

(async () => {
  const file = process.argv[2];
  const out = process.argv[3] || 'debug-layout.json';
  const buf = fs.readFileSync(file);
  const t0 = Date.now();
  const r = await analyzePdf(buf);
  fs.writeFileSync(out, JSON.stringify(r, null, 1));
  console.log('time', Date.now() - t0, 'ms');
  console.log('paragraphs', r.paragraphs.length, 'pages', r.layout.pages.length);
  for (const p of r.paragraphs.slice(0, 45)) {
    console.log(`#${p.i} p${p.page + 1} c${p.col} ${p.type}${p.level ? p.level : ''} (${p.x},${p.y},${p.w}x${p.h}) ${JSON.stringify(p.text.slice(0, 70))}`);
  }
  for (let pi = 0; pi < r.layout.pages.length; pi++) {
    const pg = r.layout.pages[pi];
    console.log(`page${pi + 1} cols=${JSON.stringify(pg.cols)} rows=${pg.rows.length} regions=${pg.regions.length}`);
    for (const f of pg.regions) console.log('   region', f.kind, f.x, f.y, f.w, f.h, f.grid ? 'grid ' + f.grid.length + 'x' + f.grid[0].length : '');
  }
})();
