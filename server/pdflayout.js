/**
 * pdflayout.js - PDF 版面分析与结构化抽取
 *
 * 目标：把学术 PDF 拆成与视觉结构一致的「块」（标题/正文/列表/公式/图/表/图注），
 * 并给出每块的精确坐标，供前端：
 *   · 阅读区按真实结构排版；
 *   · 对照视图在译文页按原文坐标重建排版；
 *   · 图/表/公式按区域截图后原位嵌入。
 *
 * 坐标约定：与 pdf.js 视口一致（单位 pt，原点左下，y 向上）。
 */
'use strict';

const RULE_T = 2.6;        // 细线判定阈值（pt）
const MIN_GUTTER = 8;      // 最小分栏间隙
const MIN_BLOCK_W = 18;

/* ---------------- 矩阵与几何 ---------------- */
function mulM(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}
const r2 = n => Math.round(n * 10) / 10;
function rectArea(r) { return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0); }
function rectInter(a, b) {
  const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1);
  const y0 = Math.max(a.y0, b.y0), y1 = Math.min(a.y1, b.y1);
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
}
function iou(a, b) {
  const i = rectInter(a, b);
  return i ? i / (rectArea(a) + rectArea(b) - i) : 0;
}
function inRect(r, x, y, slack = 0) {
  return x >= r.x0 - slack && x <= r.x1 + slack && y >= r.y0 - slack && y <= r.y1 + slack;
}
function unionRect(a, b) {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/* ---------------- 绘制指令解析 ---------------- */
async function pageShapes(pdfjs, page, W, H) {
  const images = [], paths = [];
  let ops;
  try { ops = await page.getOperatorList(); } catch (e) { return { images, paths }; }
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const PAINT = {
    [pdfjs.OPS.fill]: 'fill', [pdfjs.OPS.eoFill]: 'fill',
    [pdfjs.OPS.stroke]: 'stroke', [pdfjs.OPS.closeStroke]: 'stroke',
    [pdfjs.OPS.fillStroke]: 'both', [pdfjs.OPS.eoFillStroke]: 'both'
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === pdfjs.OPS.save) { stack.push(ctm.slice()); continue; }
    if (fn === pdfjs.OPS.restore) { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; continue; }
    if (fn === pdfjs.OPS.transform) { ctm = mulM(ctm, Array.isArray(args) ? args : [1, 0, 0, 1, 0, 0]); continue; }
    if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
      const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => [
        ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]
      ]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      if (r.x1 - r.x0 > 3 && r.y1 - r.y0 > 3) images.push(r);
      continue;
    }
    if (fn === pdfjs.OPS.constructPath) {
      let mm = null;
      for (const a of args) {
        if (Array.isArray(a) && a.length === 4 && a.every(v => typeof v === 'number' && isFinite(v))) mm = a;
      }
      if (!mm) continue;
      const r = {
        x0: Math.min(mm[0], mm[2]), y0: Math.min(mm[1], mm[3]),
        x1: Math.max(mm[0], mm[2]), y1: Math.max(mm[1], mm[3])
      };
      /* 向前找本条路径的绘制方式（fill / stroke） */
      let paint = '';
      for (let k = i + 1; k < Math.min(i + 4, ops.fnArray.length); k++) {
        const p = PAINT[ops.fnArray[k]];
        if (p) { paint = p; break; }
        if (ops.fnArray[k] === pdfjs.OPS.constructPath) break;
      }
      if (r.x1 - r.x0 > 0.4 || r.y1 - r.y0 > 0.4) paths.push({ ...r, paint });
    }
  }
  return { images, paths };
}

/* ---------------- 文本项 ---------------- */
async function pageItems(page) {
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = it.transform;
    const size = Math.abs(tr[3]) || Math.abs(it.height) || 10;
    const w = Math.max(1, it.width || 0);
    items.push({
      str: it.str, x: tr[4], y: tr[5], w, h: size,
      font: (tc.styles[it.fontName] || {}).fontFamily || ''
    });
  }
  return items;
}

/* 剔除脱离基线的上标标记（作者单位编号 "1 2 3"、脚注符号等），避免产生碎片块 */
function pruneScriptMarks(items) {
  const hist = new Map();
  for (const it of items) {
    const k = Math.round(it.h * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + it.str.length);
  }
  let body = 9, best = -1;
  for (const [k, v] of hist) if (v > best) { best = v; body = k; }
  const keep = [];
  for (const it of items) {
    const small = it.h < body * 0.7 && !/[\u4e00-\u9fa5]{1,}|[A-Za-z]{2,}/.test(it.str) && it.str.replace(/[^\w\u4e00-\u9fa5]/g, '').length <= 3;
    if (!small) { keep.push(it); continue; }
    /* 上标数字/符号：并入紧邻的前一项（如 mm + 2 → mm2），避免丢失单位指数 */
    const host = keep.find(c => Math.abs(c.y - it.y) < 4.5 && it.x - (c.x + c.w) > -1.5 && it.x - (c.x + c.w) < 4);
    if (host) { host.str += it.str; host.w = Math.max(host.w, it.x + it.w - host.x); }
  }
  return keep;
}

/* ---------------- 行 / 片段（同基线、同字号的文字块） ---------------- */
function needSpace(prevStr, nextStr) {
  if (!prevStr || !nextStr) return false;
  const a = prevStr.slice(-1), b = nextStr[0];
  if (/[\u4e00-\u9fa5]/.test(a) || /[\u4e00-\u9fa5]/.test(b)) return false;
  return /[A-Za-z0-9,;:.)%\]}'"]$/.test(a) && /^[A-Za-z0-9(\[{'"$]/.test(b);
}
/* 计算页面的竖向空白带（栏间空隙候选） */
function coverageGutters(boxes, W) {
  if (!boxes.length) return [];
  const xmin = Math.min(...boxes.map(b => b.x0));
  const xmax = Math.max(...boxes.map(b => b.x1));
  if (xmax - xmin < 80) return [];
  const grid = new Int16Array(Math.ceil(W) + 2);
  for (const b of boxes) {
    const a = Math.max(0, Math.floor(b.x0)), c = Math.min(grid.length - 1, Math.ceil(b.x1));
    for (let x = a; x < c; x++) grid[x]++;
  }
  const n = boxes.length;
  const tol = Math.max(3, Math.round(n * 0.1));
  const cuts = [];
  let run = null;
  for (let x = Math.max(1, Math.floor(xmin)); x <= Math.min(grid.length - 2, Math.ceil(xmax)); x++) {
    if (grid[x] <= tol) { if (!run) run = { a: x, b: x }; else run.b = x; }
    else { if (run && run.b - run.a + 1 >= MIN_GUTTER) cuts.push(run); run = null; }
  }
  if (run && run.b - run.a + 1 >= MIN_GUTTER) cuts.push(run);
  return cuts;
}

function buildSegments(items, gutters) {
  const sorted = items.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(0.9, Math.min(last.h, it.h) * 0.42)) last.items.push(it);
    else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  const segs = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      let text = '', prev = '';
      for (const it of cur.items) {
        text += (needSpace(prev, it.str) ? ' ' : '') + it.str;
        prev = it.str;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) segs.push({ x0: cur.x0, x1: cur.x1, y: row.y, h: cur.size, text, n: cur.items.length });
      cur = null;
    };
    for (const it of row.items) {
      if (!cur) { cur = { items: [it], x0: it.x, x1: it.x + it.w, size: it.h }; continue; }
      /* 同一基线上左右两栏的文字不得拼成一段：跨过栏间空白即强制断开 */
      const crossGutter = (gutters || []).some(g => it.x >= g.a - 1 && cur.x1 <= g.b + 1);
      if (crossGutter) { flush(); cur = { items: [it], x0: it.x, x1: it.x + it.w, size: it.h }; continue; }
      const gap = it.x - cur.x1;
      const small = it.h < cur.size * 0.78;                    // 上/下标、行内公式小字
      const sameSize = Math.abs(it.h - cur.size) <= Math.max(0.9, cur.size * 0.16);
      if (small && gap < Math.max(3, cur.size * 0.5)) { cur.items.push(it); cur.x1 = Math.max(cur.x1, it.x + it.w); continue; }
      if (sameSize && gap <= Math.max(7, cur.size * 1.6)) {
        cur.items.push(it);
        cur.x1 = Math.max(cur.x1, it.x + it.w);
        cur.size = Math.max(cur.size, it.h);
      } else { flush(); cur = { items: [it], x0: it.x, x1: it.x + it.w, size: it.h }; }
    }
    flush();
  }
  return segs.filter(s => s.text.replace(/[^\w\u4e00-\u9fa5]/g, '').length > 0 || s.text.length > 1);
}

/* ---------------- 分栏检测（覆盖度直方图） ---------------- */
function detectColumns(segs, W, H) {
  if (!segs.length) return [{ x0: 0, x1: W }];
  const xmin = Math.min(...segs.map(s => s.x0));
  const xmax = Math.max(...segs.map(s => s.x1));
  if (xmax - xmin < 80) return [{ x0: xmin, x1: xmax }];
  const grid = new Int16Array(Math.ceil(W) + 2);
  for (const s of segs) {
    const a = Math.max(0, Math.floor(s.x0)), b = Math.min(grid.length - 1, Math.ceil(s.x1));
    for (let x = a; x < b; x++) grid[x]++;
  }
  const n = segs.length;
  const tol = Math.max(3, Math.round(n * 0.1));   // 允许少量跨栏元素（通栏标题/通栏图注）穿过
  if (process.env.PL_DEBUG) {
    const cross = segs.filter(s => s.x0 < 300 && s.x1 > 300);
    console.log('[cols] n=', n, 'tol=', tol, 'crossing=', cross.length, cross.map(s => s.text.slice(0, 40)));
  }
  const cuts = [];
  let run = null;
  for (let x = Math.max(1, Math.floor(xmin)); x <= Math.min(grid.length - 2, Math.ceil(xmax)); x++) {
    if (grid[x] <= tol) { if (!run) run = { a: x, b: x }; else run.b = x; }
    else { if (run && run.b - run.a + 1 >= MIN_GUTTER) cuts.push(run); run = null; }
  }
  if (run && run.b - run.a + 1 >= MIN_GUTTER) cuts.push(run);
  /* 只保留真正把正文切开的间隙（两侧都要有足够宽度与足够文字） */
  const bands = [];
  const minBand = Math.max(60, (xmax - xmin) * 0.16);
  let start = xmin;
  for (const c of cuts) {
    const leftN = segs.filter(s => (s.x0 + s.x1) / 2 < c.a).length;
    const rightN = segs.filter(s => (s.x0 + s.x1) / 2 > c.b).length;
    if (c.a - start < minBand || xmax - c.b < minBand) continue;
    if (leftN < Math.max(3, n * 0.12) || rightN < Math.max(3, n * 0.12)) continue;
    bands.push({ x0: start, x1: c.a });
    start = c.b;
  }
  bands.push({ x0: start, x1: xmax });
  return bands.length > 1 ? bands : [{ x0: xmin, x1: xmax }];
}

/* ---------------- 表格检测 ---------------- */
function detectTables(paths, items, W, H) {
  const hLines = [], vLines = [];
  for (const p of paths) {
    const w = p.x1 - p.x0, h = p.y1 - p.y0;
    if (h <= RULE_T && w >= 22) hLines.push(p);
    else if (w <= RULE_T && h >= 8) vLines.push(p);
  }
  const used = new Set(hLines);
  const clusters = [];
  /* 以横线为种子，收集与之相交的横/竖线，形成表格网格 */
  for (const seed of hLines) {
    if (!used.has(seed)) continue;
    let box = { ...seed };
    let hcount = 1, vcount = 0;
    const group = [seed];
    used.delete(seed);
    let grew = true;
    while (grew) {
      grew = false;
      for (const hl of hLines) {
        if (!used.has(hl)) continue;
        /* 相邻单元格的边框线在竖线处断开，允许 8pt 以内的间隙 */
        const gapX = Math.max(box.x0, hl.x0) - Math.min(box.x1, hl.x1);
        if (gapX <= 8 && hl.y0 <= box.y1 + 3 && hl.y1 >= box.y0 - 3) {
          used.delete(hl); hcount++; group.push(hl); box = unionRect(box, hl); grew = true;
        }
      }
      for (const vl of vLines) {
        if (vl._taken) continue;
        if (vl.x0 >= box.x0 - 4 && vl.x1 <= box.x1 + 4 && vl.y0 <= box.y1 + 4 && vl.y1 >= box.y0 - 4) {
          vl._taken = true; vcount++; grew = true;
          box = { x0: Math.min(box.x0, vl.x0), y0: Math.min(box.y0, vl.y0), x1: Math.max(box.x1, vl.x1), y1: Math.max(box.y1, vl.y1) };
        }
      }
    }
    const area = rectArea(box);
    if (area < W * H * 0.004) continue;
    if (hcount < 2) continue;
    const inner = items.filter(it => inRect(box, it.x + it.w / 2, it.y + it.h / 2));
    if (!vcount && inner.length < 6) continue;
    clusters.push({
      kind: 'table', x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
      hLines: group.map(g => (g.y0 + g.y1) / 2).sort((a, b) => b - a),
      vLines: vLines.filter(v => v._taken && v.x0 >= box.x0 - 4 && v.x1 <= box.x1 + 4 && v.y0 <= box.y1 + 4 && v.y1 >= box.y0 - 4).map(v => (v.x0 + v.x1) / 2).sort((a, b) => a - b)
    });
  }
  /* 合并重叠/紧邻的表格碎片（单元格边框被拆成多段的情况） */
  const merged = [];
  for (const c of clusters.sort((a, b) => rectArea(b) - rectArea(a))) {
    const hit = merged.find(m =>
      rectInter(m, c) > 0.35 * rectArea(c) ||
      (Math.abs(m.y0 - c.y0) < 8 && Math.abs(m.y1 - c.y1) < 8 && Math.max(m.x0, c.x0) - Math.min(m.x1, c.x1) < 12));
    if (!hit) merged.push(c);
    else {
      hit.x0 = Math.min(hit.x0, c.x0); hit.y0 = Math.min(hit.y0, c.y0);
      hit.x1 = Math.max(hit.x1, c.x1); hit.y1 = Math.max(hit.y1, c.y1);
      hit.hLines = Array.from(new Set([...(hit.hLines || []), ...(c.hLines || [])])).sort((a, b) => b - a);
      hit.vLines = Array.from(new Set([...(hit.vLines || []), ...(c.vLines || [])])).sort((a, b) => a - b);
    }
  }
  /* 三线表 / 无竖线表：按横线分组（排除页眉页脚装饰线），再用区域内的分行分列文本校验 */
  const ruleTables = [];
  const safeH = hLines.filter(l => {
    const y = (l.y0 + l.y1) / 2;
    return y < H * 0.88 && y > H * 0.07;
  });
  const usedH = new Set();
  for (const seed of safeH) {
    if (usedH.has(seed)) continue;
    let g = [seed]; usedH.add(seed);
    let gx0 = seed.x0, gx1 = seed.x1, gy0 = seed.y0, gy1 = seed.y1;
    let grew = true;
    while (grew) {
      grew = false;
      for (const hl of safeH) {
        if (usedH.has(hl)) continue;
        if (hl.y0 > gy1 + 210 || hl.y1 < gy0 - 210) continue;
        const ov = Math.min(gx1, hl.x1) - Math.max(gx0, hl.x0);
        const minW = Math.min(gx1 - gx0, hl.x1 - hl.x0);
        if (ov > minW * 0.55) {
          g.push(hl); usedH.add(hl);
          gx0 = Math.min(gx0, hl.x0); gx1 = Math.max(gx1, hl.x1);
          gy0 = Math.min(gy0, hl.y0); gy1 = Math.max(gy1, hl.y1);
          grew = true;
        }
      }
    }
    if (g.length < 2) continue;
    if (gy1 - gy0 < 16) continue;
    const box = { x0: gx0, x1: gx1, y0: gy0 - 1, y1: gy1 + 1 };
    if ((box.x1 - box.x0) < W * 0.25) continue;
    const inner = items.filter(it => inRect(box, it.x + it.w / 2, it.y + it.h / 2));
    if (inner.length < 6) continue;
    const rowKeys = new Set(inner.map(it => Math.round(it.y / 7)));
    const colXs = [];
    for (const it of inner.slice().sort((a, b) => a.x - b.x)) {
      if (!colXs.some(x => Math.abs(x - it.x) < 16)) colXs.push(it.x);
    }
    if (rowKeys.size < 3 || colXs.length < 2) continue;
    ruleTables.push({ kind: 'table', ...box, hLines: [], vLines: [] });
  }
  for (const t of ruleTables) {
    const hit = merged.find(m => rectInter(m, t) > 0.5 * rectArea(t));
    if (!hit) merged.push(t);
  }
  return merged.filter(t => (t.x1 - t.x0) * (t.y1 - t.y0) < W * H * 0.92);
}

/* ---------------- 图片 / 矢量图 / 公式区域 ---------------- */
function detectGraphics(images, paths, tables, items, W, H) {
  const out = [];
  const pageArea = W * H;
  const inTable = r => tables.some(t => rectInter(t, r) > 0.35 * rectArea(r));

  /* 1) 位图 */
  const imgs = [];
  for (const im of images) {
    const w = im.x1 - im.x0, h = im.y1 - im.y0;
    if (w < 60 || h < 22) continue;                    // logo / 装饰
    if (w * h < pageArea * 0.0035) continue;           // 面积过小（出版社徽标等）
    if (w * h > pageArea * 0.96) continue;
    if (inTable(im)) continue;
    if (imgs.some(x => iou(x, im) > 0.55)) continue;   // 重复图层
    imgs.push(im);
  }
  /* 2) 矢量图形簇：排除细线（表格线/分隔线）与背景大色块 */
  const solids = paths.filter(p => {
    const w = p.x1 - p.x0, h = p.y1 - p.y0;
    return !(h <= RULE_T || w <= RULE_T) && w * h > 12;
  });
  let clusters = [];
  for (const s of solids) clusters.push({ ...s, n: 1 });
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i], b = clusters[j];
        if (a.x0 <= b.x1 + 7 && b.x0 <= a.x1 + 7 && a.y0 <= b.y1 + 7 && b.y0 <= a.y1 + 7) {
          clusters[i] = { ...unionRect(a, b), n: a.n + b.n, paint: a.paint || b.paint };
          clusters.splice(j, 1); changed = true; break outer;
        }
      }
    }
  }
  for (const c of clusters) {
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    if (c.n < 7) continue;
    if (w < 60 || h < 30) continue;
    if (w * h < pageArea * 0.012) continue;
    if (w * h > pageArea * 0.75) continue;
    if (inTable(c)) continue;
    const textLen = items.reduce((s, it) => (inRect(c, it.x + it.w / 2, it.y + it.h / 2) ? s + it.str.length : s), 0);
    if (textLen > 260) continue;                       // 大色块/装饰框，内含正文
    if (imgs.some(im => rectInter(im, c) > 0.5 * rectArea(im))) {
      const host = imgs.find(im => rectInter(im, c) > 0.5 * rectArea(im));
      host.x0 = Math.min(host.x0, c.x0); host.y0 = Math.min(host.y0, c.y0);
      host.x1 = Math.max(host.x1, c.x1); host.y1 = Math.max(host.y1, c.y1);
      continue;
    }
    out.push({ kind: 'figure', ...c, n: c.n });
  }

  /* 3) 位图：区分「插图」与「公式图片」 */
  for (const im of imgs) {
    const w = im.x1 - im.x0, h = im.y1 - im.y0;
    const ratio = w / Math.max(1, h);
    const formulaish = (ratio >= 2.6 && h <= 64) || (h <= 34 && w >= 60 && w < 240);
    /* 公式图片：把同行右侧的编号 "(3)" 并入区域 */
    let box = { ...im };
    if (formulaish) {
      for (const it of items) {
        if (Math.abs(it.y - (im.y0 + im.y1) / 2) > h * 0.7) continue;
        if (it.x > im.x1 && it.x < im.x1 + 46 && /^\(?\d+[a-z]?\)?$/.test(it.str.trim())) {
          box.x1 = it.x + it.w;
        }
      }
    }
    out.push({ kind: formulaish ? 'formula' : 'figure', ...box });
  }

  /* 4) 合并同一图形被拆开的框，剔除被大框吞并的小框 */
  const final = [];
  for (const r of out.sort((a, b) => rectArea(b) - rectArea(a))) {
    const host = final.find(f => rectInter(f, r) > 0.7 * rectArea(r) || iou(f, r) > 0.5);
    if (host) { host.x0 = Math.min(host.x0, r.x0); host.y0 = Math.min(host.y0, r.y0); host.x1 = Math.max(host.x1, r.x1); host.y1 = Math.max(host.y1, r.y1); continue; }
    final.push({ ...r });
  }
  return final
    .map(r => ({ kind: r.kind, x0: r2(r.x0), y0: r2(r.y0), x1: r2(r.x1), y1: r2(r.y1) }))
    .filter(r => (r.x1 - r.x0) > 24 && (r.y1 - r.y0) > 10);
}

/* ---------------- 表格单元格解析 ---------------- */
function parseTableGrid(t, items) {
  const inner = items.filter(it => inRect(t, it.x + it.w / 2, it.y + it.h / 2));
  if (!inner.length) return null;
  /* 列边界：合并同一竖线被拆成多段的碎片，并补齐左右外框 */
  let xs = [];
  if (t.vLines && t.vLines.length >= 2) {
    for (const x of t.vLines.slice().sort((a, b) => a - b)) {
      if (!xs.length || x - xs[xs.length - 1] > 4) xs.push(x);
    }
    if (xs[0] > t.x0 + 6) xs.unshift(t.x0);
    if (t.x1 - xs[xs.length - 1] > 6) xs.push(t.x1);
    else xs[xs.length - 1] = t.x1;
  } else {
    for (const it of inner.slice().sort((a, b) => a.x - b.x)) {
      if (!xs.length || it.x - xs[xs.length - 1] > 12) xs.push(it.x);
    }
    xs.unshift(t.x0 - 1); xs.push(t.x1);
  }
  xs = xs.filter((x, i) => i === 0 || x - xs[i - 1] > 12);
  if (xs.length < 2) return null;

  /* 行边界：优先用横线（更贴近真实合并单元格），否则按基线聚类 */
  let ys = [];
  if (t.hLines && t.hLines.length >= 2) {
    for (const y of t.hLines.slice().sort((a, b) => b - a)) {
      if (!ys.length || ys[ys.length - 1] - y > 3) ys.push(y);
    }
    if (ys[0] < t.y1 - 4) ys.unshift(t.y1);
    if (ys[ys.length - 1] > t.y0 + 4) ys.push(t.y0);
  }
  const bandOf = y => {
    if (ys.length >= 2) {
      for (let i = 0; i < ys.length - 1; i++) if (y <= ys[i] + 1 && y > ys[i + 1] - 1) return i;
      return y > ys[0] ? 0 : ys.length - 2;
    }
    return -1;
  };
  const colOf = x => {
    let k = 0;
    for (let i = 0; i < xs.length; i++) if (x >= xs[i] - 3) k = i;
    return Math.min(k, xs.length - 2);
  };

  const nCols = xs.length - 1;
  const rows = [];
  if (ys.length >= 2) {
    for (let i = 0; i < ys.length - 1; i++) rows.push(new Array(nCols).fill(''));
  }
  /* 无横线时按基线聚成行 */
  const fallbackRows = [];
  if (!rows.length) {
    let last = null;
    for (const it of inner.slice().sort((a, b) => b.y - a.y)) {
      if (!last || Math.abs(last.y - it.y) > Math.max(2, it.h * 0.6)) { last = { y: it.y, cells: new Array(nCols).fill('') }; fallbackRows.push(last); }
      const c = colOf(it.x + it.w / 2);
      last.cells[c] = (last.cells[c] ? last.cells[c] + ' ' : '') + it.str;
    }
  }
  const target = rows.length ? rows : fallbackRows.map(r => r.cells);
  for (const it of inner.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
    const ri = rows.length ? bandOf(it.y) : fallbackRows.findIndex(r => Math.abs(r.y - it.y) <= Math.max(2, it.h * 0.6));
    if (ri < 0 || ri >= target.length) continue;
    const c = colOf(it.x + it.w / 2);
    target[ri][c] = (target[ri][c] ? target[ri][c] + ' ' : '') + it.str;
  }
  const grid = target
    .map(r => r.map(c => c.replace(/\s+/g, ' ').trim()))
    .filter(r => r.some(Boolean));
  if (grid.length < 2 || grid[0].length < 2) return null;
  return {
    cols: xs.slice(0, -1).map((x, i) => ({ x, w: xs[i + 1] - x })),
    grid
  };
}

/* ---------------- 判型 ---------------- */
const MATH_RE = /[=+\-×÷±≈≤≥∑∏∫√∞^_<>≠∂∇αβγδεθλμνρστφχψωΩΔ]/g;
const STRONG_MATH = /[=∫∑∏√≤≥≈±∇∂]/;
function looksFormula(t) {
  const s = String(t).trim();
  if (s.length < 3 || s.length > 220) return false;
  if (!STRONG_MATH.test(s)) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const digits = (s.match(/\d/g) || []).length;
  const math = (s.match(MATH_RE) || []).length;
  const words = (s.match(/[A-Za-z]{3,}/g) || []).length;
  return math >= 2 && words <= 2 && digits + math >= letters * 0.75;
}
function classify(text, size, bodySize, centered) {
  const t = String(text).trim();
  if (/^[图表]\s*\d+/.test(t)) return { type: 'caption' };
  if (/^(fig(ure)?\.?|table|tab\.)\s*\d+/i.test(t) && t.length < 300
      && !/^(fig(ure)?\.?|table|tab\.)\s*\d+(?:\([a-z]\))?\s+(represents|shows|illustrates|depicts|presents|gives|compares|indicates|lists|summari)/i.test(t)) return { type: 'caption' };
  const num = t.match(/^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s*([\u4e00-\u9fa5A-Z].*)$/);
  if (num && t.length < 130 && !/[.;,。，]$/.test(t) && (t.match(/[A-Za-z\u4e00-\u9fa5]{3,}/g) || []).length >= 1) {
    return { type: 'heading', level: Math.min(3, num[1].split('.').length), num: num[1] };
  }
  if (/^([IVX]{1,4}\.|\d+\.)\s+[A-Z]/.test(t) && t.length < 120) return { type: 'heading', level: 1 };
  if (size >= bodySize * 1.12 && t.length < 150 && !looksFormula(t) && (t.match(/[A-Za-z\u4e00-\u9fa5]/g) || []).length >= 3) {
    return { type: 'heading', level: size >= bodySize * 1.4 ? 1 : 2 };
  }
  if (/^[·•◦▪●]\s?/.test(t)) return { type: 'list', marker: '·' };
  if (/^[-–—]\s+[^\s]/.test(t) && t.length < 240) return { type: 'list', marker: '•' };
  if (/^\(?([a-z]|\d{1,2})[).]\s+/.test(t) && t.length < 240) return { type: 'list', marker: t.match(/^\(?([a-z]|\d{1,2})[).]/)[0] };
  if (looksFormula(t) && (centered || t.length < 90)) return { type: 'formula' };
  return { type: 'para' };
}

/* ---------------- 块聚合 ---------------- */
function blocksFromColumn(segs, bodySize, colX0, colX1) {
  const sorted = segs.slice().sort((a, b) => (b.y - a.y) || (a.x0 - b.x0));
  const blocks = [];
  let cur = null;
  const push = () => {
    if (!cur) return;
    cur.text = cur.text.replace(/\s+/g, ' ').trim();
    if (cur.text) blocks.push(cur);
    cur = null;
  };
  for (const s of sorted) {
    if (!cur) {
      cur = { text: s.text, x0: s.x0, x1: s.x1, yTop: s.y, yBot: s.y - s.h, size: s.h, segs: [s], lines: 1, lastY: s.y };
      continue;
    }
    const gap = cur.lastY - s.y;
    const lead = Math.max(s.h, cur.size);
    const sameSize = Math.abs(s.h - cur.size) <= Math.max(0.9, cur.size * 0.09);
    const indent = s.x0 - Math.min(...cur.segs.map(x => x.x0));
    const numberedStart = /^\d{1,2}(?:\.\d{1,2}){0,3}\.?\s*[\u4e00-\u9fa5A-Z]/.test(s.text) || /^[IVX]+\.\s/.test(s.text);
    const newPara =
      !sameSize ||
      numberedStart ||
      gap > lead * 1.52 ||
      (cur.lines >= 2 && indent > Math.max(4, cur.size * 0.55) && /[.!?。！？]"?$/.test(cur.text)) ||
      (/^[·•◦▪●]/.test(s.text) && cur.lines >= 1);
    if (newPara) { push(); cur = { text: s.text, x0: s.x0, x1: s.x1, yTop: s.y, yBot: s.y - s.h, size: s.h, segs: [s], lines: 1, lastY: s.y }; continue; }
    /* 续行：连字符断词直接拼接 */
    const hyphen = /[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(s.text);
    if (hyphen) cur.text = cur.text.replace(/-$/, '');
    cur.text += (hyphen ? '' : ' ') + s.text;
    cur.x0 = Math.min(cur.x0, s.x0);
    cur.x1 = Math.max(cur.x1, s.x1);
    cur.yBot = Math.min(cur.yBot, s.y - s.h);
    cur.size = Math.max(cur.size, s.h);
    cur.segs.push(s);
    cur.lines++;
    cur.lastY = s.y;
  }
  push();
  /* 合并被误切的短标题（相邻、同字号、无句末标点） */
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    const bHead = b.size >= bodySize * 1.12 && b.text.length < 120;
    const lHead = last && last.size >= bodySize * 1.12 && last.text.length < 120;
    const gapOk = last && (last.yBot + last.size * 0.9) - b.yTop > -6;
    const bNumbered = /^\d+(?:\.\d+)*\.?\s/.test(b.text) || /^[IVX]+\.\s/.test(b.text);
    if (last && bHead && lHead && gapOk && !bNumbered && Math.abs(last.size - b.size) < 1.2 && !/[.;]$/.test(last.text)) {
      last.text += ' ' + b.text;
      last.x0 = Math.min(last.x0, b.x0); last.x1 = Math.max(last.x1, b.x1);
      last.yBot = Math.min(last.yBot, b.yBot); last.segs.push(...b.segs); last.lines += b.lines;
    } else merged.push(b);
  }
  /* 碎片合并：扫描版/OCR 常把公式或上下标拆成独立小块（如 "x"、"TRb"、"ro-6"），
     这里把同一基线上、水平相邻的极短片段并回宿主块，避免被单独翻译 */
  const mergeFragments = list => {
    const isFrag = b => {
      const t = b.text.trim();
      if (!t || t.length > 40) return false;
      if (b.yTop - b.yBot > 18) return false;
      if (/[。！？.!?]$/.test(t)) return false;
      return true;
    };
    const out = [];
    for (const b of list.slice().sort((a, c) => c.yTop - a.yTop)) {
      if (!isFrag(b)) { out.push(b); continue; }
      let host = null;
      for (const o of out) {
        /* 必须落在同一视觉行内（上下标的高差远小于行距），避免把相邻行的短行/列表项并进来 */
        const tolY = Math.max(4, Math.min(o.size || 9, b.size || 9) * 0.6);
        if (Math.abs(o.yTop - b.yTop) > tolY) continue;
        const gap = Math.max(o.x0, b.x0) - Math.min(o.x1, b.x1);
        if (gap <= 60) { host = o; break; }
      }
      if (!host) { out.push(b); continue; }
      const before = b.x0 < host.x0;
      host.text = before ? (b.text + host.text) : (host.text + (b.x0 - host.x1 > 2 ? ' ' : '') + b.text);
      host.x0 = Math.min(host.x0, b.x0);
      host.x1 = Math.max(host.x1, b.x1);
      host.yBot = Math.min(host.yBot, b.yBot);
      host.segs.push(...b.segs);
    }
    return out.sort((a, c) => c.yTop - a.yTop);
  };
  const merged0 = mergeFragments(merged);

  /* 编号小标题与正文黏在同一块时，把首行拆成独立标题块 */
  const splitLeadingHeading = list => {
    const out = [];
    for (const b of list) {
      if (b.segs && b.segs.length >= 2) {
        const first = b.segs[0];
        const rest = b.segs.slice(1);
        const headText = first.text.trim();
        if (/^\d{1,2}(?:\.\d{1,2}){1,3}\.?\s*[\u4e00-\u9fa5A-Z]/.test(headText) && headText.length <= 60) {
          const mkb = segs => {
            let text = '';
            for (const sg of segs) {
              const hyphen = /[A-Za-z]-$/.test(text) && /^[a-z]/.test(sg.text);
              if (hyphen) text = text.replace(/-$/, '');
              text += (hyphen || !text ? '' : ' ') + sg.text;
            }
            return {
              text: text.replace(/\s+/g, ' ').trim(),
              x0: Math.min(...segs.map(x => x.x0)), x1: Math.max(...segs.map(x => x.x1)),
              yTop: Math.max(...segs.map(x => x.y)), yBot: Math.min(...segs.map(x => x.y - x.h)),
              size: Math.max(...segs.map(x => x.h)), segs, lines: segs.length, lastY: Math.min(...segs.map(x => x.y))
            };
          };
          out.push(mkb([first]));
          out.push(mkb(rest));
          continue;
        }
      }
      out.push(b);
    }
    return out;
  };
  const merged1 = splitLeadingHeading(merged0);

  /* 超长段落兜底切分：按句子边界拆成便于阅读与翻译的若干块 */
  const splitLong = list => {
    const out = [];
    for (const b of list) {
      if (!b.segs || b.segs.length < 6 || b.text.length <= 700) { out.push(b); continue; }
      const parts = [];
      let cur = [], len = 0;
      for (let k = 0; k < b.segs.length; k++) {
        const sg = b.segs[k];
        cur.push(sg); len += sg.text.length;
        const ends = /[.!?。！？]["”’)]?$/.test(sg.text.trim());
        if (len >= 340 && ends && k + 1 < b.segs.length) { parts.push(cur); cur = []; len = 0; }
      }
      if (cur.length) parts.push(cur);
      if (parts.length < 2) { out.push(b); continue; }
      for (const segs of parts) {
        let text = '', prev = '';
        for (const sg of segs) {
          const hyphen = /[A-Za-z]-$/.test(text) && /^[a-z]/.test(sg.text);
          if (hyphen) text = text.replace(/-$/, '');
          text += (hyphen || !text ? '' : ' ') + sg.text;
          prev = sg.text;
        }
        void prev;
        out.push({
          text: text.replace(/\s+/g, ' ').trim(),
          x0: Math.min(...segs.map(x => x.x0)), x1: Math.max(...segs.map(x => x.x1)),
          yTop: Math.max(...segs.map(x => x.y)), yBot: Math.min(...segs.map(x => x.y - x.h)),
          size: Math.max(...segs.map(x => x.h)), segs, lines: segs.length, lastY: Math.min(...segs.map(x => x.y))
        });
      }
    }
    return out;
  };
  const merged2 = splitLong(merged1);
  return merged2.map(b => {
    const centerX = Math.abs((b.x0 + b.x1) / 2 - (colX0 + colX1) / 2) < Math.max(7, (colX1 - colX0) * 0.06);
    return {
      ...b,
      col: colX0,
      centerX,
      /* 居中且不占满整栏：用于判公式（避免把整行正文误判为居中式公式） */
      centered: centerX && (b.x1 - b.x0) < (colX1 - colX0) * 0.78
    };
  });
}

/* ---------------- 主流程 ---------------- */
async function analyzePdf(buf, opts = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  const paras = [];
  let seq = 0;
  const figSeq = { n: 0 };

  for (let p = 0; p < doc.numPages; p++) {
    const page = await doc.getPage(p + 1);
    const vp = page.getViewport({ scale: 1 });
    const W = Math.round(vp.width), H = Math.round(vp.height);
    const items = pruneScriptMarks(await pageItems(page));
    const { images, paths } = await pageShapes(pdfjs, page, W, H);
    const tables = detectTables(paths, items, W, H);
    const graphics = detectGraphics(images, paths, tables, items, W, H);
    const regions = [...tables, ...graphics];

    /* 区域占用判定：区域内的文字不进入正文流（图形与表格整体以图像呈现） */
    const inside = (it, r) => {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      return inRect(r, cx, cy, 0.5);
    };
    const flowItems = items.filter(it => !regions.some(r => inside(it, r)));
    const gutters = coverageGutters(flowItems.map(it => ({ x0: it.x, x1: it.x + it.w })), W);
    const segs = buildSegments(flowItems, gutters);
    const bodySize = estimateBodySize(segs);
    const cols = detectColumns(segs, W, H);
    const pageRows = [];

    /* 文字块 */
    const colBlocks = new Map();     // colIndex -> blocks
    for (let ci = 0; ci < cols.length; ci++) {
      const inCol = segs.filter(s => {
        const cx = (s.x0 + s.x1) / 2;
        if (cx >= cols[ci].x0 && cx < cols[ci].x1) return true;
        /* 跨栏块归入重叠最大的一栏 */
        if (cx < cols[ci].x0 || cx > cols[ci].x1) {
          let best = 0, bi = 0;
          for (let k = 0; k < cols.length; k++) {
            const ov = Math.min(s.x1, cols[k].x1) - Math.max(s.x0, cols[k].x0);
            if (ov > best) { best = ov; bi = k; }
          }
          return bi === ci;
        }
        return false;
      });
      colBlocks.set(ci, blocksFromColumn(inCol, bodySize, cols[ci].x0, cols[ci].x1));
    }

    /* 图形/表格/公式块 */
    const regionBlocks = [];
    for (const r of regions) {
      const pg = { idx: p, page: p };
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      let ci = 0, bestOv = -1;
      for (let k = 0; k < cols.length; k++) {
        const ov = Math.min(r.x1, cols[k].x1) - Math.max(r.x0, cols[k].x0);
        if (ov > bestOv) { bestOv = ov; ci = k; }
      }
      const id = 'f' + (++figSeq.n);
      /* 表格与插图一律按区域截图呈现，不再抽取单元格文字（避免中文表格错位） */
      const fig = {
        id, kind: r.kind, page: p,
        x: r2(r.x0), y: r2(r.y0), w: r2(r.x1 - r.x0), h: r2(r.y1 - r.y0),
        crop: '', grid: null, cols: null
      };
      regionBlocks.push({ col: ci, y: r.y1, kind: r.kind, fig });
    }

    /* 合并（按栏、按 y 自上而下） */
    const all = [];
    for (let ci = 0; ci < cols.length; ci++) {
      for (const b of colBlocks.get(ci) || []) all.push({ col: ci, y: b.yTop, kind: 'text', b });
      for (const rb of regionBlocks.filter(x => x.col === ci)) all.push(rb);
    }
    /* ---- 文字型公式整块转为「区域截图」，保证公式排版与原文完全一致 ---- */
    for (const e of all) {
      if (e.kind === 'text') e.cls = classify(e.b.text, e.b.size, bodySize, e.b.centered);
    }
    const mathish = t => {
      const s = String(t || '').trim();
      if (!s || s.length > 70) return false;
      if (looksFormula(s)) return true;
      if (!/[=∂∇ρτσ±≤≥]/.test(s)) return false;
      return (s.match(/[A-Za-z]/g) || []).length <= 12;
    };
    const isEq = e => {
      const t = String(e.b.text || '').trim();
      if (e.cls.type === 'formula') return true;
      if (mathish(t)) return true;
      /* 居中且含等号的短块：多为排版成文本的公式（限制词数，避免正文误判） */
      return e.b.centerX && /=/.test(t) && t.length <= 160 && t.split(/\s+/).length <= 13;
    };
    const dropSet = new Set();
    const newRegions = [];
    const pendingExpand = [];
    for (let ci = 0; ci < cols.length; ci++) {
      const cand = all.filter(e => e.kind === 'text' && e.col === ci && isEq(e))
        .sort((a, b2) => b2.b.yTop - a.b.yTop);
      let group = [];
      const flush = () => {
        if (group.length) {
          const box = group.reduce((r, g) => ({
            x0: Math.min(r.x0, g.b.x0), x1: Math.max(r.x1, g.b.x1),
            y0: Math.min(r.y0, g.b.yBot), y1: Math.max(r.y1, g.b.yTop)
          }), { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 });
          const fig = {
            id: 'f' + (++figSeq.n), kind: 'formula', page: p,
            x: r2(box.x0), y: r2(box.y0), w: r2(box.x1 - box.x0), h: r2(box.y1 - box.y0),
            crop: '', grid: null, cols: null
          };
          const rb = { col: ci, y: box.y1, kind: 'formula', fig };
          newRegions.push(rb);
          pendingExpand.push({ rb, size: Math.max(...group.map(g => g.b.size), 8) });
          regionBlocks.push(rb);
          group.forEach(g => dropSet.add(g));
        }
        group = [];
      };
      for (const it of cand) {
        const last = group[group.length - 1];
        if (last && (last.b.yBot - it.b.yTop) > 12) flush();
        group.push(it);
      }
      flush();
    }
    /* 吸收落在公式框内/紧邻的碎片（上下标、编号等），一并纳入截图 */
    for (const rb of newRegions) {
      const f = rb.fig;
      for (const e of all) {
        if (e.kind !== 'text' || dropSet.has(e)) continue;
        const cx = (e.b.x0 + e.b.x1) / 2, cy = (e.b.yTop + e.b.yBot) / 2;
        if (cx >= f.x - 5 && cx <= f.x + f.w + 5 && cy >= f.y - 6 && cy <= f.y + f.h + 6) dropSet.add(e);
      }
    }
    /* 公式裁切框纵向外扩：分式/上下标的字形会超出基线框，需向上补足上缘，向下留出下缘；
       以相邻块为界，避免把上下文字带进截图 */
    for (const { rb, size } of pendingExpand) {
      const f = rb.fig;
      let aboveBottom = Infinity, belowTop = -Infinity;
      for (const e of all) {
        if (dropSet.has(e)) continue;
        if (e.kind === 'text') {
          if (e.col !== rb.col) continue;
          if (e.b.yBot >= f.y + f.h - 0.5) aboveBottom = Math.min(aboveBottom, e.b.yBot);
          if (e.b.yTop <= f.y + 0.5) belowTop = Math.max(belowTop, e.b.yTop);
        } else {
          const rr = e.fig;
          if (rr.y >= f.y + f.h - 0.5) aboveBottom = Math.min(aboveBottom, rr.y);
          if (rr.y + rr.h <= f.y + 0.5) belowTop = Math.max(belowTop, rr.y + rr.h);
        }
      }
      const topPad = Math.min(size * 1.0, isFinite(aboveBottom) ? Math.max(0.6, aboveBottom - (f.y + f.h) - 0.4) : size);
      const botPad = Math.min(size * 0.5, isFinite(belowTop) ? Math.max(0.6, f.y - belowTop - 0.4) : size * 0.5);
      f.y = r2(f.y - botPad);
      f.h = r2(f.h + botPad + topPad);
      rb.y = f.y + f.h;
    }

    if (dropSet.size) {
      for (let k = all.length - 1; k >= 0; k--) if (dropSet.has(all[k])) all.splice(k, 1);
      for (const rb of newRegions) all.push(rb);
    }

    /* 阅读顺序：通栏元素（整宽表格/图/图注）切分横向带，带内先左栏后右栏，带间自上而下 */
    const contentW = Math.max(1, cols[cols.length - 1].x1 - cols[0].x0);
    const spanOf = e => e.kind === 'text'
      ? [e.b.x0, e.b.x1]
      : [e.fig.x, e.fig.x + e.fig.w];
    const isFullWide = e => {
      const [x0, x1] = spanOf(e);
      return (x1 - x0) > contentW * 0.72;
    };
    {
      const byY = all.slice().sort((a, b2) => b2.y - a.y);
      const ordered = [];
      let band = [];
      const flushBand = () => {
        band.sort((a, b2) => (a.col - b2.col) || (b2.y - a.y));
        ordered.push(...band);
        band = [];
      };
      for (const e of byY) {
        if (isFullWide(e)) { flushBand(); ordered.push(e); }
        else band.push(e);
      }
      flushBand();
      all.length = 0;
      all.push(...ordered);
    }

    const pageParas = [];
    for (const entry of all) {
      if (entry.kind === 'text') {
        const b = entry.b;
        const cls = classify(b.text, b.size, bodySize, b.centered);
        /* 页码 / 页眉页脚等版面附属文字：不参与翻译与正文排版 */
        const furniture = /^\d{1,4}$/.test(b.text.trim()) || ((b.yTop > H - 32 || b.yBot < 30) && b.text.length < 90);
        const rowIdx = [];
        for (const s of b.segs) {
          const ri = pageRows.length;
          pageRows.push({ x: Math.round(s.x0), y: Math.round(s.y), w: Math.round(s.x1 - s.x0), h: Math.round(s.h), text: s.text });
          rowIdx.push(ri);
        }
        const para = {
          i: seq++, type: furniture ? 'meta' : cls.type, text: b.text,
          page: p, col: entry.col,
          x: r2(b.x0), y: r2(b.yBot), w: r2(b.x1 - b.x0), h: r2(b.yTop - b.yBot),
          size: r2(b.size),
          level: cls.level || 0, num: cls.num || '', marker: cls.marker || '',
          rows: rowIdx.map(ri => ({ page: p, row: ri }))
        };
        paras.push(para); pageParas.push({ para, rows: para.rows });
      } else {
        const f = entry.fig;
        const kind = f.kind;
        const text = '';
        const type = kind;
        const para = {
          i: seq++, type, text,
          page: p, col: entry.col,
          x: f.x, y: f.y, w: f.w, h: f.h, size: 0,
          level: 0, num: '', marker: '', region: f.id, rows: []
        };
        f.para = para.i;
        paras.push(para); pageParas.push({ para, rows: [] });
      }
    }
    /* 收集本页区域 */
    const pageFigs = regionBlocks.map(rb => rb.fig);
    /* 表格/公式块补上 para 索引 */
    for (const f of pageFigs) {
      const hit = paras.find(x => x.region === f.id);
      if (hit) f.para = hit.i;
    }
    pages.push({
      w: W, h: H, cols: cols.map(c => ({ x0: Math.round(c.x0), x1: Math.round(c.x1) })),
      rows: pageRows, regions: pageFigs
    });
    void pageParas;
  }

  /* 跨页重复的页眉/页脚（期刊名、DOI 行、页码等）统一标记为版面附属文字 */
  const norm = t => String(t || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const seen = new Map();
  for (const p of paras) {
    if (p.type === 'meta' || !p.text || p.text.length > 120) continue;
    const k = norm(p.text);
    if (k.length < 6) continue;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(p);
  }
  const pagesTotal = Math.max(1, pages.length);
  for (const [, list] of seen) {
    const pgs = new Set(list.map(p => p.page));
    if (pgs.size >= Math.max(2, Math.ceil(pagesTotal * 0.3))) {
      for (const p of list) { p.type = 'meta'; p.level = 0; }
    }
  }

  return {
    paragraphs: paras.map(p => {
      const { rows, ...rest } = p;
      return rest;
    }),
    layout: {
      version: 7,
      pages,
      paras: paras.map(p => ({ i: p.i, page: p.page, col: p.col, x: p.x, y: p.y, w: p.w, h: p.h, type: p.type, rows: p.rows || [] }))
    }
  };
}

function estimateBodySize(segs) {
  const hist = new Map();
  for (const s of segs) {
    const k = Math.round(s.h * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + s.text.length);
  }
  let best = 9, bestN = -1;
  for (const [k, v] of hist) if (v > bestN) { bestN = v; best = k; }
  return best;
}

module.exports = { analyzePdf };
