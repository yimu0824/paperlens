/**
 * reader.js - ① 文章阅读区
 *   · 文本视图：按「标题 / 正文 / 列表 / 图注 / 公式 / 图 / 表」结构化呈现中英对照
 *   · 对照视图：左原文页面（像素级）+ 右译文重建页（同坐标、同结构重新排版）
 *   · 图/表/公式：从原页面按版面区域截取，原位嵌入
 *   · 划词标色 / 批注 / 中英联动 / 边栏批注卡
 */
import { $, $$, esc, uid, toast, store, api, consumeSSE } from './core.js';
import { refreshNotes } from './notes.js';

export const HL_COLORS = {
  yellow: '#fff3b0', green: '#d9f7de', blue: '#d4e8ff', red: '#ffdcd6', purple: '#ecdaff'
};
let selRange = null;          // {para, side, start, end, text}
let pendingNoteForSel = null; // 划词后点"批注"→弹出气泡输入

const TEXT_TYPES = ['para', 'heading', 'list', 'caption'];
const isMedia = p => p.type === 'figure' || p.type === 'table' || p.type === 'formula';
const needZh = p => TEXT_TYPES.includes(p.type) && !!String(p.text || '').trim();
const hasZh = p => !needZh(p) || !!(p.zh && String(p.zh).trim());

/* ================= 区域索引 ================= */
export function regionIndex() {
  const m = new Map();
  for (const pg of (store.layout && store.layout.pages) || []) {
    for (const r of (pg.regions || [])) m.set(r.id, r);
  }
  store._regionById = m;
  return m;
}
function regionOf(p) {
  if (!p.region) return null;
  if (!store._regionById) regionIndex();
  return store._regionById.get(p.region) || null;
}
function cropUrl(r) {
  if (!r || !r.crop || !store.current) return '';
  return `/media/crops/${store.current.id}/${r.crop}`;
}
function mediaPlaceholder(label, id) {
  return `<div class="media-ph" data-region="${esc(id)}"><span>${esc(label)}</span></div>`;
}

/* ================= 文本视图 ================= */
export async function renderReader() {
  const c = $('#reader-content');
  const s = store.current;
  c.classList.remove('original-mode');
  c.classList.remove('parallel-mode');
  if (!s) {
    c.innerHTML = `<div class="reader-empty">
      <div style="font-size:40px">📖</div>
      <p><b>从左侧目录选择文献，或点击顶部「上传文献」</b></p>
      <p>支持 txt / md / pdf / docx，导入后自动建立带结构的中英对照阅读视图</p>
    </div>`;
    $('#reader-title').textContent = '未打开文献';
    $('#reader-meta').textContent = '';
    return;
  }
  $('#reader-title').textContent = s.name;
  if (!s.lang || s.lang !== 'zh') regionIndex();
  const list = store.paragraphs.filter(p => p.type !== 'meta');
  const zhDone = list.filter(p => needZh(p) && p.zh).length;
  const zhTotal = list.filter(needZh).length;
  $('#reader-meta').textContent = `${list.length} 个内容块 · ${s.lang === 'zh' ? '中文文献 · 单语阅读（图表按原版面截图）' : (zhDone >= zhTotal ? '中英对照就绪' : `已译 ${zhDone}/${zhTotal}`)}`;
  c.innerHTML = list.map(p => blockHtml(p)).join('');
  ensureCrops();
  applyAllHighlights();
  renderGutter();
}

const BULLET = /^[·•◦▪●]\s*/;
function stripMarker(t, marker) {
  let s = String(t || '');
  s = s.replace(BULLET, '');
  const m = String(marker || '').trim();
  if (m) {
    const esc0 = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('^' + esc0 + '\\s*'), '');
    const core = m.replace(/[()（）.、]/g, '');
    if (core) s = s.replace(new RegExp('^[\\(（]\\s*' + core + '\\s*[\\)）]\\s*'), '');
  } else {
    s = s.replace(/^[\(（]\s*([a-zA-Z0-9]{1,2})\s*[\)）]\s*/, '');
  }
  return s;
}

function blockHtml(p) {
  const t = p.type;
  if (t === 'figure' || t === 'formula' || t === 'table') return mediaHtml(p);
  const head = t === 'heading';
  const cls = ['blk', 't-' + t, head ? 'h' + (p.level || 2) : ''].filter(Boolean).join(' ');
  const clean = t === 'list' ? stripMarker(p.text, p.marker) : p.text;
  const isZhDoc = store.current && store.current.lang === 'zh';
  if (isZhDoc) {
    const body = `<div class="t-zh" data-side="zh" data-i="${p.i}">${esc(clean)}</div>`;
    return t === 'list'
      ? `<div class="${cls}" data-i="${p.i}"><span class="li-dot">${esc(p.marker || '·')}</span><div class="li-body">${body}</div></div>`
      : `<div class="${cls}" data-i="${p.i}">${body}</div>`;
  }
  const en = `<div class="t-en" data-side="en" data-i="${p.i}">${esc(clean)}</div>`;
  let zh;
  if (p.zh && String(p.zh).trim()) {
    zh = `<div class="t-zh" data-side="zh" data-i="${p.i}">${esc(p.zh)}</div>`;
  } else if (store.current && store.current.lang === 'zh') {
    zh = '';
  } else {
    zh = `<div class="t-zh pending" data-side="zh" data-i="${p.i}">（待翻译 · 点击顶部「翻译全文」生成对照）</div>`;
  }
  if (t === 'list') {
    return `<div class="${cls}" data-i="${p.i}"><span class="li-dot">${esc(p.marker || '·')}</span>
      <div class="li-body">${en}${zh}</div></div>`;
  }
  return `<div class="${cls}" data-i="${p.i}">${en}${zh}</div>`;
}

function mediaHtml(p) {
  const r = regionOf(p);
  const src = cropUrl(r);
  /* 纯文字型公式（无图像区域）：按公式样式原样呈现，不做翻译 */
  if (!r && p.text) {
    return `<div class="blk t-formula-text" data-i="${p.i}"><div class="formula-body">${esc(p.text)}</div></div>`;
  }
  const inner = src
    ? `<img class="fig-img" data-region="${esc(p.region)}" src="${src}" alt="论文图表">`
    : mediaPlaceholder(p.type === 'table' ? '正在截取表格…' : p.type === 'formula' ? '正在截取公式…' : '正在截取插图…', p.region);
  const cls = p.type === 'figure' ? 't-figure' : p.type === 'table' ? 't-table' : 't-formula';
  const tag = p.type === 'figure' ? 'figure' : 'div';
  return `<${tag} class="blk ${cls}" data-i="${p.i}" data-region="${esc(p.region)}">${inner}</${tag}>`;
}

/* ================= 标注应用（按字符区间包裹 span） ================= */
export function applyAllHighlights() {
  const bySide = {};
  for (const a of store.annotations) {
    const k = a.para + '|' + a.side;
    (bySide[k] || (bySide[k] = [])).push(a);
  }
  for (const [k, list] of Object.entries(bySide)) {
    const [i, side] = k.split('|');
    const tEl = $(`#reader-content .t-${side}[data-i="${i}"]`);
    if (!tEl) continue;
    const text = tEl.textContent;
    const cover = new Array(text.length).fill(null);
    for (const a of list.slice().sort((x, y) => x.start - y.start)) {
      if (a.start < 0 || a.end > text.length || a.start >= a.end) continue;
      for (let j = a.start; j < a.end; j++) if (!cover[j]) cover[j] = a;
    }
    let html = '', j = 0;
    while (j < text.length) {
      const a = cover[j];
      let k2 = j;
      while (k2 < text.length && cover[k2] === a) k2++;
      const frag = esc(text.slice(j, k2));
      if (a) html += `<span class="hl ${a.note ? 'note-mark' : ''}" data-ann="${a.id}" style="background:${HL_COLORS[a.color] || HL_COLORS.yellow}">${frag}</span>`;
      else html += frag;
      j = k2;
    }
    tEl.innerHTML = html;
  }
}

/* ================= 边栏批注卡 ================= */
export function renderGutter() {
  if (store.viewMode === 'original' || store.viewMode === 'parallel') {
    $('#reader-wrap').classList.remove('has-gutter');
    $('#gutter').innerHTML = '';
    return;
  }
  const g = $('#gutter');
  const wrap = $('#reader-wrap');
  const notes = store.annotations.filter(a => a.note && a.view !== 'original');
  wrap.classList.toggle('has-gutter', store.showGutter && notes.length > 0);
  if (!store.showGutter || !notes.length) { g.innerHTML = ''; return; }
  g.innerHTML = notes.map(a => {
    const blk = $(`#reader-content .blk[data-i="${a.para}"]`);
    const top = blk ? blk.offsetTop + 4 : 0;
    return `<div class="gutter-card" data-ann="${a.id}" style="top:${Math.max(4, top)}px;border-left-color:${HL_COLORS[a.color] || HL_COLORS.yellow}">
      <div class="gq">“${esc(String(a.quote || '').slice(0, 60))}${(a.quote || '').length > 60 ? '…' : ''}”</div>
      <div class="gn">${esc(a.note)}</div>
    </div>`;
  }).join('');
  g.querySelectorAll('.gutter-card').forEach(card => {
    card.onclick = () => locateAnnotation(card.dataset.ann);
  });
}

/* ================= 选中与工具栏 ================= */
export function initReaderEvents() {
  const content = $('#reader-content');
  const scroll = $('#reader-scroll');
  $('#swatches').innerHTML = swatchHtml();

  content.addEventListener('mouseup', e => {
    if (e.target.closest('.hl')) return;
    setTimeout(() => handleSelection(e), 0);
  });
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#sel-toolbar') && !e.target.closest('.hl') && !e.target.closest('#ann-popover')) {
      hideToolbar(); hidePopover();
    }
  });

  content.addEventListener('click', e => {
    const hl = e.target.closest('.hl');
    if (hl) { showPopoverFor(hl.dataset.ann, hl); e.stopPropagation(); }
  });

  let rafId = 0;
  scroll.addEventListener('scroll', () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; renderGutter(); });
  });

  $('#sel-toolbar').addEventListener('click', async e => {
    const sw = e.target.closest('.sw');
    if (sw) { await createAnnotation(sw.dataset.color); return; }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(selRange.text); toast('已复制', 'ok', 1200); } catch (err) { toast('复制失败', 'err'); }
      hideToolbar();
    } else if (act === 'transfer') {
      await createAnnotation(null, { transfer: true });
    } else if (act === 'note') {
      await createAnnotation(null, { openNote: true });
    }
  });

  $('#pop-note').addEventListener('input', debounce(async () => {
    const a = store.annotations.find(x => x.id === popAnnId);
    if (!a) return;
    a.note = $('#pop-note').value; a.noteUpdatedAt = Date.now();
    await persistAnnotations();
    applyAllHighlights(); renderGutter(); refreshNotes();
  }, 500));
  $('#pop-transfer').onclick = async () => {
    const a = store.annotations.find(x => x.id === popAnnId);
    if (a && !a.transferredAt) { a.transferredAt = Date.now(); await persistAnnotations(); refreshNotes(); toast('已转入实时笔记', 'ok', 1500); }
    hidePopover();
  };
  $('#pop-delete').onclick = async () => {
    store.annotations = store.annotations.filter(x => x.id !== popAnnId);
    await persistAnnotations();
    applyAllHighlights(); renderGutter(); refreshNotes();
    toast('已删除标注', '', 1400);
    hidePopover();
  };
  $('#pop-swatches').addEventListener('click', async e => {
    const sw = e.target.closest('.sw'); if (!sw) return;
    const a = store.annotations.find(x => x.id === popAnnId);
    if (a) { a.color = sw.dataset.color; await persistAnnotations(); applyAllHighlights(); renderGutter(); refreshNotes(); }
    hidePopover();
  });
}

function handleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideToolbar(); return; }
  const range = sel.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const el = container.nodeType === 1 ? container : container.parentElement;
  const sideEl = el ? el.closest('.t-en, .t-zh') : null;
  if (!sideEl) { hideToolbar(); return; }
  const text = sideEl.textContent;
  const pre = document.createRange();
  pre.selectNodeContents(sideEl);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  if (end <= start) { hideToolbar(); return; }
  selRange = {
    para: +sideEl.dataset.i, side: sideEl.dataset.side,
    start, end, text: range.toString()
  };
  const blk = sideEl.closest('.blk');
  const other = blk ? blk.querySelector(sideEl.classList.contains('t-en') ? '.t-zh' : '.t-en') : null;
  if (other) {
    other.classList.remove('linked-flash');
    void other.offsetWidth;
    other.classList.add('linked-flash');
    setTimeout(() => other.classList.remove('linked-flash'), 1200);
  }
  const rect = range.getBoundingClientRect();
  const tb = $('#sel-toolbar');
  tb.hidden = false;
  tb.style.left = Math.max(8, Math.min(window.innerWidth - tb.offsetWidth - 8, rect.left)) + 'px';
  tb.style.top = Math.max(8, rect.top - tb.offsetHeight - 8 < 8 ? rect.bottom + 8 : rect.top - tb.offsetHeight - 8) + 'px';
}
function hideToolbar() { $('#sel-toolbar').hidden = true; selRange = null; }

async function createAnnotation(color, opts = {}) {
  if (!selRange) return;
  let a;
  if (selRange.original) {
    a = {
      id: uid(), view: 'original', segs: selRange.segs,
      quote: selRange.text, counterpart: '', color: color || 'yellow',
      note: '', createdAt: Date.now(), transferredAt: null, noteUpdatedAt: null
    };
  } else {
    const sideEl = $(`#reader-content .t-${selRange.side}[data-i="${selRange.para}"]`);
    const blk = sideEl ? sideEl.closest('.blk') : null;
    const otherEl = blk ? blk.querySelector(selRange.side === 'en' ? '.t-zh' : '.t-en') : null;
    let counterpart = otherEl ? otherEl.textContent.slice(0, 300) : '';
    if (!counterpart) {
      const src = store.paragraphs.find(x => x.i === selRange.para);
      if (src) counterpart = String(selRange.side === 'zh' ? (src.text || '') : (src.zh || '')).slice(0, 300);
    }
    a = {
      id: uid(), para: selRange.para, side: selRange.side,
      start: selRange.start, end: selRange.end,
      quote: selRange.text, counterpart, color: color || 'yellow',
      note: '', createdAt: Date.now(), transferredAt: null, noteUpdatedAt: null
    };
  }
  store.annotations.push(a);
  await persistAnnotations();
  hideToolbar();
  window.getSelection().removeAllRanges();
  if (store.viewMode === 'original') drawOriginalHighlights();
  else { applyAllHighlights(); renderGutter(); }
  if (opts.transfer) {
    a.transferredAt = Date.now();
    await persistAnnotations();
    refreshNotes();
    toast('已转入实时笔记，可在中栏记录想法', 'ok');
  } else if (opts.openNote) {
    a.transferredAt = Date.now();
    a.noteUpdatedAt = null;
    await persistAnnotations();
    refreshNotes({ focusNew: a.id });
    toast('已转入笔记并新建批注，请在中栏输入想法', 'ok');
  } else {
    refreshNotes();
  }
}

export async function persistAnnotations() {
  if (!store.current) return;
  try { await api.saveAnnotations(store.current.id, store.annotations); }
  catch (e) { toast('保存标注失败：' + e.message, 'err'); }
}

/* ================= 标注气泡 ================= */
let popAnnId = null;
function showPopoverFor(annId, hlEl) {
  const a = store.annotations.find(x => x.id === annId);
  if (!a) return;
  popAnnId = annId;
  const pop = $('#ann-popover');
  $('#pop-swatches').innerHTML = swatchHtml(a.color);
  $('#pop-note').value = a.note || '';
  $('#pop-transfer').style.display = a.transferredAt ? 'none' : '';
  pop.hidden = false;
  const r = hlEl.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 10, r.left)) + 'px';
  pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 10, r.bottom + 8) + 'px';
}
function hidePopover() { $('#ann-popover').hidden = true; popAnnId = null; }
function swatchHtml(active) {
  return Object.entries(HL_COLORS).map(([k, v]) =>
    `<span class="sw c-${k}" data-color="${k}" style="background:${v};${active === k ? 'outline:2px solid var(--accent);outline-offset:1px;' : ''}"></span>`).join('');
}

/* ================= 定位 ================= */
export function locateAnnotation(annId) {
  const a = store.annotations.find(x => x.id === annId);
  if (!a) return;
  let target = null;
  if (a.view === 'original' && a.segs && a.segs.length) {
    const g = a.segs[0];
    target = $(`#reader-content .orow[data-page="${g.page}"][data-row="${g.row}"]`);
  } else {
    target = $(`#reader-content .blk[data-i="${a.para}"]`);
  }
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const holder = target.closest('.opg') || target;
  holder.classList.remove('flash-target'); void holder.offsetWidth; holder.classList.add('flash-target');
}

/* ================= 翻译 ================= */
export async function translateAll() {
  const s = store.current;
  if (!s) return toast('请先打开文献', 'err');
  if (!store.config || !store.config.process || !store.config.process.hasKey) {
    return toast('尚未配置「文献处理 API」Key：请到 ⚙ 设置 → API 配置 填写并保存后重试', 'err', 4500);
  }
  const targets = store.paragraphs.filter(p => needZh(p) && !p.zh);
  if (!targets.length) { toast('所有内容块均已翻译', 'ok'); return; }
  const bar = $('#trans-progress');
  bar.hidden = false;
  const btn = $('#btn-translate'); btn.disabled = true;
  const ctrl = new AbortController();
  let watchdog = 0;
  const resetWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), 180000); };
  resetWatchdog();
  let failed = 0, firstError = '', aborted = false, done = 0;
  try {
    await consumeSSE(`/api/files/${s.id}/translate`, { indexes: null }, {
      progress: j => {
        resetWatchdog();
        done = j.done;
        bar.textContent = `翻译中 ${j.done}/${j.total}${j.failed ? '（失败 ' + j.failed + '）' : ''}`;
        if (j.zh) {
          const p = store.paragraphs.find(x => x.i === j.index);
          if (p) p.zh = j.zh;
          const el = $(`#reader-content .t-zh[data-i="${j.index}"]`);
          if (el) { el.classList.remove('pending'); el.textContent = j.zh; }
        }
        if (j.failed) failed = j.failed;
      },
      done: j => { failed = j.failed || 0; firstError = j.firstError || ''; },
      error: e => { throw new Error(e.message); }
    }, ctrl.signal);
  } catch (e) {
    if (e.name === 'AbortError') aborted = true;
    else toast('翻译中断：' + e.message, 'err', 4200);
  }
  clearTimeout(watchdog);
  try {
    store.paragraphs = await api.paragraphs(s.id);
    if (store.viewMode === 'parallel') await renderParallelView();
    else await renderReader();
  } catch (e) {}
  bar.hidden = true; btn.disabled = false;
  const okCount = store.paragraphs.filter(p => needZh(p) && p.zh).length;
  if (aborted) toast('翻译响应超时，已读取服务器已保存的结果', '', 3600);
  if (failed > 0) toast(`翻译结束：成功 ${okCount} 块，失败 ${failed} 块${firstError ? '——' + firstError : ''}`, okCount ? '' : 'err', 5500);
  else if (!aborted) toast('翻译完成，中英对照已生成', 'ok');
}

/* ================= 图表区域截取（按版面区域，从原页面裁切） ================= */
let cropJob = null;
export async function ensureCrops() {
  const s = store.current;
  if (!s || !store.layout || !store.layout.pages) return cropJob;
  if (cropJob) return cropJob;
  regionIndex();
  const missing = [];
  for (const pg of store.layout.pages) for (const r of (pg.regions || [])) if (!r.crop) missing.push(r);
  if (!missing.length) return;
  cropJob = (async () => {
    try {
      const lib = await ensurePdfjs();
      if (pdfDocId !== s.id || !pdfDoc) {
        const resp = await fetch(api.originalUrl(s.id));
        if (!resp.ok) return;
        pdfDoc = await lib.getDocument({ data: new Uint8Array(await resp.arrayBuffer()) }).promise;
        pdfDocId = s.id;
      }
      const byPage = new Map();
      for (const r of missing) {
        if (!byPage.has(r.page)) byPage.set(r.page, []);
        byPage.get(r.page).push(r);
      }
      const upload = async crops => {
        if (!crops.length) return;
        try {
          const rr = await fetch(`/api/files/${s.id}/crops`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ crops })
          });
          const j = await rr.json();
          for (const [id, name] of Object.entries(j.saved || {})) {
            const r = (store._regionById || new Map()).get(id);
            if (r) r.crop = name;
            patchMedia(id, cropUrl(r));
          }
        } catch (e) { /* 单批失败忽略 */ }
      };
      /* 按页并发渲染裁切，每完成一页立即上传并就地替换占位图（首开更快、渐进显示） */
      const jobs = Array.from(byPage.entries());
      let cursor = 0;
      const worker = async () => {
        while (cursor < jobs.length) {
          const [p, list] = jobs[cursor++];
          const out = [];
          try {
            const page = await pdfDoc.getPage(p + 1);
            const pg = store.layout.pages[p];
            const scale = Math.min(2.6, Math.max(1.8, 1400 / Math.max(1, pg.w)));
            const vp = page.getViewport({ scale });
            const cv = document.createElement('canvas');
            cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
            await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            for (const r of list) {
              const pad = 2;
              const sx = Math.max(0, (r.x - pad) * scale);
              const sy = Math.max(0, (pg.h - r.y - r.h - pad) * scale);
              const sw = Math.min(cv.width - sx, (r.w + pad * 2) * scale);
              const sh = Math.min(cv.height - sy, (r.h + pad * 2) * scale);
              if (sw < 4 || sh < 4) continue;
              const c2 = document.createElement('canvas');
              c2.width = Math.round(sw); c2.height = Math.round(sh);
              const ctx2 = c2.getContext('2d');
              ctx2.fillStyle = '#fff'; ctx2.fillRect(0, 0, c2.width, c2.height);
              ctx2.drawImage(cv, sx, sy, sw, sh, 0, 0, c2.width, c2.height);
              const mime = r.kind === 'figure' ? 'image/jpeg' : 'image/png';
              out.push({ id: r.id, dataUrl: c2.toDataURL(mime, 0.93) });
            }
          } catch (e) { /* 单页失败忽略 */ }
          await upload(out);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
    } catch (e) { console.warn('图表截取失败', e); }
    cropJob = null;
  })();
  return cropJob;
}
/* 兼容旧调用名 */
export const extractGraphicCrops = ensureCrops;

function patchMedia(regionId, url) {
  if (!url) return;
  $$(`#reader-content [data-region="${regionId}"]`).forEach(el => {
    const ph = el.querySelector ? el.querySelector('.media-ph') : null;
    if (el.classList && el.classList.contains('media-ph')) {
      const img = document.createElement('img');
      img.className = 'fig-img';
      img.dataset.region = regionId;
      img.src = url;
      img.alt = '论文图表';
      el.replaceWith(img);
    } else if (el.tagName === 'IMG') {
      el.src = url;
    } else if (ph) {
      const img = document.createElement('img');
      img.className = 'fig-img';
      img.dataset.region = regionId;
      img.src = url;
      img.alt = '论文图表';
      ph.replaceWith(img);
    }
  });
}

/* ================= 工具 ================= */
function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ================= PDF 位图渲染 ================= */
let pdfjsLib = null;
let pdfDoc = null, pdfDocId = null;
let originalScale = 1;
let originalOffsets = {};

async function ensurePdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjsLib;
}
export async function renderReaderMeta() {
  const s = store.current;
  if (!s) return;
  const list = store.paragraphs.filter(p => p.type !== 'meta');
  const zhDone = list.filter(p => needZh(p) && p.zh).length;
  const zhTotal = list.filter(needZh).length;
  $('#reader-meta').textContent = `${list.length} 个内容块 · ${s.lang === 'zh' ? '中文文献 · 单语阅读（图表按原版面截图）' : (zhDone >= zhTotal ? '中英对照就绪' : `已译 ${zhDone}/${zhTotal}`)}`;
}
/* ================= 原文视图（单栏原版页：位图 + 可划词文本层，无译文） ================= */
export async function renderOriginalView() {
  const c = $('#reader-content');
  const s = store.current;
  if (!s) return renderReader();
  if (!store.layout) {
    try { store.layout = await api.layout(s.id); } catch (e) { store.layout = null; }
  }
  if (!store.layout || !store.layout.pages || !store.layout.pages.length) {
    toast('该文献缺少版面数据（旧版导入），删除后重新上传即可启用原文视图', 'err', 4200);
    store.viewMode = 'text';
    $('#btn-original').classList.remove('on');
    restoreDrawer();
    return renderReader();
  }
  const zoneR = $('#zone-reader');
  if (!zoneR.classList.contains('no-drawer')) { zoneR.classList.add('no-drawer'); store._drawerWasOpen = true; }
  else store._drawerWasOpen = false;
  $('#reader-title').textContent = s.name;
  $('#parallel-tools').hidden = true;
  readerMetaTxt(`原文视图 · ${store.layout.pages.length} 页 · 可划词标注`);
  c.innerHTML = '<div class="orig-loading dim">正在渲染 PDF 原版页面…</div>';
  const lib = await ensurePdfjs();
  if (pdfDocId !== s.id || !pdfDoc) {
    const resp = await fetch(api.originalUrl(s.id));
    if (!resp.ok) { toast('原始 PDF 加载失败', 'err'); store.viewMode = 'text'; restoreDrawer(); return renderReader(); }
    pdfDoc = await lib.getDocument({ data: new Uint8Array(await resp.arrayBuffer()) }).promise;
    pdfDocId = s.id;
  }
  const layout = store.layout;
  c.classList.add('original-mode', 'parallel-mode');
  const dpr = Math.max(1.5, Math.min(2, window.devicePixelRatio || 1.5));
  const base = Math.max(0.3, Math.min(1.8, (c.clientWidth - 48) / layout.pages[0].w));
  const layoutScale = base * (store.viewScale || 1);
  const renderScale = layoutScale * dpr;
  originalScale = layoutScale;
  originalOffsets = {};
  const col = document.createElement('div');
  col.className = 'pcol pcol-single';
  for (let p = 0; p < layout.pages.length; p++) {
    const pg = layout.pages[p];
    const tag = document.createElement('div');
    tag.className = 'ptag';
    tag.textContent = `第 ${p + 1} 页 · 原文`;
    col.appendChild(tag);
    col.appendChild(buildOriginalPage(p, pg, layoutScale, renderScale, pg.h * layoutScale));
  }
  const wrap = document.createElement('div');
  wrap.className = 'pwrap pwrap-single';
  wrap.appendChild(col);
  c.innerHTML = '';
  c.appendChild(wrap);
  drawOriginalHighlights();
  bindOriginalEvents();
}

/* 构建一页原版页：canvas 位图 + 透明文本层 + 高亮层 */
function buildOriginalPage(p, pg, layoutScale, renderScale, totalH) {
  const pgL = document.createElement('div');
  pgL.className = 'opg';
  pgL.dataset.page = p;
  pgL.style.width = Math.round(pg.w * layoutScale) + 'px';
  pgL.style.height = Math.round(totalH) + 'px';
  const cv = document.createElement('canvas');
  cv.className = 'ocanvas';
  cv.width = Math.round(pg.w * renderScale);
  cv.height = Math.round(pg.h * renderScale);
  cv.style.height = Math.round(pg.h * layoutScale) + 'px';
  pgL.appendChild(cv);
  const rowLayer = document.createElement('div');
  rowLayer.className = 'orow-layer';
  (pg.rows || []).forEach((row, ri) => {
    const span = document.createElement('span');
    span.className = 'orow';
    span.textContent = row.text;
    span.style.left = (row.x * layoutScale) + 'px';
    span.style.top = ((pg.h - row.y - row.h) * layoutScale) + 'px';
    span.style.width = (row.w * layoutScale) + 'px';
    span.style.height = (row.h * layoutScale) + 'px';
    span.style.fontSize = (row.h * layoutScale * 0.8) + 'px';
    span.dataset.page = p;
    span.dataset.row = ri;
    rowLayer.appendChild(span);
  });
  pgL.appendChild(rowLayer);
  const hlLayer = document.createElement('div');
  hlLayer.className = 'ohl-layer';
  pgL.appendChild(hlLayer);
  (async () => {
    try {
      const page = await pdfDoc.getPage(p + 1);
      const viewport = page.getViewport({ scale: renderScale });
      await page.render({ canvasContext: cv.getContext('2d'), viewport }).promise;
    } catch (e) { /* 单页失败忽略 */ }
  })();
  return pgL;
}
export function restoreDrawer() {
  if (store._drawerWasOpen) { $('#zone-reader').classList.remove('no-drawer'); store._drawerWasOpen = false; }
}

/* 高亮层：按行内字符占比绘制色块 */
export function drawOriginalHighlights() {
  const c = $('#reader-content');
  c.querySelectorAll('.ohl-layer').forEach(l => { l.innerHTML = ''; });
  const rows = {};
  c.querySelectorAll('.orow').forEach(sp => { rows[sp.dataset.page + '-' + sp.dataset.row] = sp; });
  for (const a of store.annotations.filter(x => x.view === 'original')) {
    for (const g of (a.segs || [])) {
      const sp = rows[g.page + '-' + g.row];
      if (!sp) continue;
      const info = originalOffsets[g.page];
      const extra = info && info.offs ? info.offs[g.row] : 0;
      const len = Math.max(1, sp.textContent.length);
      const x0 = Math.max(0, Math.min(1, g.start / len));
      const x1 = Math.max(0, Math.min(1, g.end / len));
      if (x1 <= x0) continue;
      const block = document.createElement('div');
      block.className = 'hl2';
      block.dataset.ann = a.id;
      block.style.left = (sp.offsetLeft + sp.offsetWidth * x0) + 'px';
      block.style.top = (sp.offsetTop + extra) + 'px';
      block.style.width = Math.max(4, sp.offsetWidth * (x1 - x0)) + 'px';
      block.style.height = sp.offsetHeight + 'px';
      block.style.background = HL_COLORS[a.color] || HL_COLORS.yellow;
      if (a.note) block.style.boxShadow = '0 0 0 1.5px var(--accent)';
      sp.closest('.opg').querySelector('.ohl-layer').appendChild(block);
    }
  }
}
export function drawOriginalTranslations() {
  const c = $('#reader-content');
  c.querySelectorAll('.ozh').forEach(el => { el.style.display = store.showZh ? '' : 'none'; });
}

/* 原版划词 */
let origBound = false;
function bindOriginalEvents() {
  if (origBound) return;
  origBound = true;
  const content = $('#reader-content');
  content.addEventListener('mouseup', e => {
    if (e.target.closest('.hl2')) return;
    if (store.viewMode !== 'original' && store.viewMode !== 'parallel') return;
    /* 对照视图右栏是可排版的译文 DOM，交给普通划词逻辑（支持中文标注） */
    if (e.target.closest('.t-zh, .t-en, .zh-page')) return;
    setTimeout(() => handleOriginalSelection(), 0);
  });
  content.addEventListener('click', e => {
    const hl = e.target.closest('.hl2');
    if (hl && (store.viewMode === 'original' || store.viewMode === 'parallel')) {
      const a = store.annotations.find(x => x.id === hl.dataset.ann);
      if (a) showPopoverFor(a.id, hl);
    }
  });
}

function handleOriginalSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { hideToolbar(); return; }
  const range = sel.getRangeAt(0);
  const nodeRow = nd => { const el = nd.nodeType === 1 ? nd : nd.parentElement; return el ? el.closest('.orow') : null; };
  const startSpan = nodeRow(range.startContainer);
  const endSpan = nodeRow(range.endContainer);
  if (!startSpan || !endSpan) { hideToolbar(); return; }
  const offIn = (span, container, offset) => {
    const pre = document.createRange();
    pre.selectNodeContents(span);
    try { pre.setEnd(container, offset); } catch (e) { return 0; }
    return pre.toString().length;
  };
  const all = Array.from($('#reader-content').querySelectorAll('.orow'));
  const segs = [];
  let inRange = false;
  for (const sp of all) {
    if (sp === startSpan) inRange = true;
    if (inRange) {
      const text = sp.textContent;
      let s0 = 0, e0 = text.length;
      if (sp === startSpan) s0 = offIn(sp, range.startContainer, range.startOffset);
      if (sp === endSpan) e0 = offIn(sp, range.endContainer, range.endOffset);
      if (sp === startSpan && sp === endSpan) {
        if (e0 > s0) segs.push({ page: +sp.dataset.page, row: +sp.dataset.row, start: s0, end: e0 });
        break;
      }
      if (e0 > s0) segs.push({ page: +sp.dataset.page, row: +sp.dataset.row, start: s0, end: e0 });
    }
    if (sp === endSpan) break;
  }
  if (!segs.length) { hideToolbar(); return; }
  const quote = segs.map(g => {
    const sp = $(`#reader-content .orow[data-page="${g.page}"][data-row="${g.row}"]`);
    return sp ? sp.textContent.slice(g.start, g.end) : '';
  }).join(' ').replace(/\s+/g, ' ').trim();
  if (!quote) { hideToolbar(); return; }
  selRange = { original: true, segs, text: quote };
  const rect = range.getBoundingClientRect();
  const tb = $('#sel-toolbar');
  tb.hidden = false;
  tb.style.left = Math.max(8, Math.min(window.innerWidth - tb.offsetWidth - 8, rect.left)) + 'px';
  tb.style.top = Math.max(8, rect.top - tb.offsetHeight - 8 < 8 ? rect.bottom + 8 : rect.top - tb.offsetHeight - 8) + 'px';
}

/* ================= 对照视图：左原文 / 右译文重建页 ================= */
export async function renderParallelView(opts = {}) {
  const c = $('#reader-content');
  const s = store.current;
  if (!s) return renderReader();
  /* 中文文献不生成译文页：对照视图仅服务外文文献 */
  if (s.lang === 'zh') {
    store.viewMode = 'text';
    $('#btn-parallel').classList.remove('on');
    $('#parallel-tools').hidden = true;
    restoreDrawer();
    toast('中文文献不需要译文对照，已在阅读区单语显示', '', 2400);
    return renderReader();
  }
  if (!store.layout) {
    try { store.layout = await api.layout(s.id); } catch (e) { store.layout = null; }
  }
  if (!store.layout || !store.layout.pages || !store.layout.pages.length) {
    toast('该文献缺少版面数据（旧版导入），删除后重新上传即可启用对照视图', 'err', 4200);
    store.viewMode = 'text';
    $('#btn-parallel').classList.remove('on');
    $('#parallel-tools').hidden = true;
    restoreDrawer();
    return renderReader();
  }
  regionIndex();
  const zoneR = $('#zone-reader');
  if (!zoneR.classList.contains('no-drawer')) { zoneR.classList.add('no-drawer'); store._drawerWasOpen = true; }
  else store._drawerWasOpen = false;
  $('#reader-title').textContent = s.name;
  $('#parallel-tools').hidden = false;
  readerMetaTxt(`对照视图 · ${store.layout.pages.length} 页 · 左原文 / 右译文（同版面结构）`);
  c.innerHTML = '<div class="orig-loading dim">正在重建译文版式…</div>';
  const lib = await ensurePdfjs();
  if (pdfDocId !== s.id || !pdfDoc) {
    const resp = await fetch(api.originalUrl(s.id));
    if (!resp.ok) { toast('原始 PDF 加载失败', 'err'); store.viewMode = 'text'; restoreDrawer(); return renderReader(); }
    pdfDoc = await lib.getDocument({ data: new Uint8Array(await resp.arrayBuffer()) }).promise;
    pdfDocId = s.id;
  }
  const layout = store.layout;
  c.classList.add('original-mode', 'parallel-mode');
  const dpr = Math.max(1.5, Math.min(2, window.devicePixelRatio || 1.5));
  const onlyZh = opts.onlyOriginal ? false : false;
  const base = Math.max(0.3, Math.min(1.5, (c.clientWidth - 76) / 2 / layout.pages[0].w));
  const layoutScale = base * (store.viewScale || 1);
  const renderScale = layoutScale * dpr;
  originalScale = layoutScale;
  originalOffsets = {};

  const wrap = document.createElement('div');
  wrap.className = 'pwrap';
  const colL = document.createElement('div'); colL.className = 'pcol';
  const colR = document.createElement('div'); colR.className = 'pcol';
  wrap.appendChild(colL); wrap.appendChild(colR);
  c.innerHTML = '';
  c.appendChild(wrap);

  for (let p = 0; p < layout.pages.length; p++) {
    const pg = layout.pages[p];
    /* 右栏：译文重建页（先挂载再量高，保证高度测量有效） */
    const tagR0 = document.createElement('div');
    tagR0.className = 'ptag';
    tagR0.textContent = `第 ${p + 1} 页 · 译文`;
    colR.appendChild(tagR0);
    let zhPage = buildZhPage(p, layoutScale, colR, 1);
    let zhH = parseFloat(zhPage.style.height) || pg.h * layoutScale;
    const targetH = pg.h * layoutScale;
    /* 中文比英文占位更宽：若译文溢出原页高度，整页等比缩小字号（不低于原号 72%），保持版面对齐 */
    if (zhH > targetH * 1.05) {
      const fs = Math.max(0.72, Math.min(1, targetH / zhH));
      zhPage.remove();
      zhPage = buildZhPage(p, layoutScale, colR, fs);
      zhH = parseFloat(zhPage.style.height) || targetH;
    }
    const H = Math.max(targetH, zhH);
    /* 左栏 */
    const tagL = document.createElement('div');
    tagL.className = 'ptag';
    tagL.textContent = `第 ${p + 1} 页 · 原文`;
    colL.appendChild(tagL);
    const pgL = document.createElement('div');
    pgL.className = 'opg';
    pgL.dataset.page = p;
    pgL.style.width = Math.round(pg.w * layoutScale) + 'px';
    pgL.style.height = Math.round(H) + 'px';
    const cvL = document.createElement('canvas');
    cvL.className = 'ocanvas';
    cvL.width = Math.round(pg.w * renderScale);
    cvL.height = Math.round(pg.h * renderScale);
    cvL.style.height = Math.round(pg.h * layoutScale) + 'px';
    pgL.appendChild(cvL);
    const rowLayer = document.createElement('div');
    rowLayer.className = 'orow-layer';
    (pg.rows || []).forEach((row, ri) => {
      const span = document.createElement('span');
      span.className = 'orow';
      span.textContent = row.text;
      span.style.left = (row.x * layoutScale) + 'px';
      span.style.top = ((pg.h - row.y - row.h) * layoutScale) + 'px';
      span.style.width = (row.w * layoutScale) + 'px';
      span.style.height = (row.h * layoutScale) + 'px';
      span.style.fontSize = (row.h * layoutScale * 0.8) + 'px';
      span.dataset.page = p;
      span.dataset.row = ri;
      rowLayer.appendChild(span);
    });
    pgL.appendChild(rowLayer);
    const hlLayer = document.createElement('div');
    hlLayer.className = 'ohl-layer';
    pgL.appendChild(hlLayer);
    colL.appendChild(pgL);
    (async () => {
      try {
        const page = await pdfDoc.getPage(p + 1);
        const viewport = page.getViewport({ scale: renderScale });
        await page.render({ canvasContext: cvL.getContext('2d'), viewport }).promise;
      } catch (e) { /* 单页失败忽略 */ }
    })();

    zhPage.style.height = Math.round(H) + 'px';
  }
  applyColVisibility();
  drawOriginalHighlights();
  bindOriginalEvents();
  ensureCrops();
  if (onlyZh) { /* 预留：仅显示译文 */ }
}

function readerMetaTxt(t) { $('#reader-meta').textContent = t; }

/* 生成一页「译文重建页」：块沿用原文坐标，同栏内按高度顺延，避免重叠 */
function buildZhPage(pageIndex, scale, mount, fs) {
  fs = fs || 1;
  const pg = store.layout.pages[pageIndex];
  const W = Math.round(pg.w * scale);
  const cols = (pg.cols && pg.cols.length) ? pg.cols : [{ x0: 0, x1: pg.w }];
  const el = document.createElement('div');
  el.className = 'opg zh-page';
  el.dataset.page = pageIndex;
  el.style.width = W + 'px';
  el.style.minHeight = Math.round(pg.h * scale) + 'px';
  if (mount) mount.appendChild(el);

  const blocks = store.paragraphs.filter(p => p.page === pageIndex && p.type !== 'meta');
  const items = [];
  const cursor = new Array(cols.length).fill(0);
  for (const p of blocks) {
    const ci = Math.max(0, Math.min(cols.length - 1, p.col || 0));
    const col = cols[ci] || { x0: 0, x1: pg.w };
    const node = zhBlockNode(p, scale, fs);
    if (!node) continue;
    /* 通栏块（起点在所属栏左侧 / 右端越过栏边界）：按原始宽度铺开，并让所有栏一起下推 */
    const spanning = p.x < col.x0 - 10 || (p.x + p.w) > col.x1 + 10;
    node.style.left = Math.round(p.x * scale) + 'px';
    node.style.width = Math.max(36, Math.round((spanning ? p.w : (col.x1 - p.x)) * scale) - 2) + 'px';
    el.appendChild(node);
    items.push({ p, node, ci, spanning });
  }
  items.sort((a, b) => (b.p.y - a.p.y) || (a.ci - b.ci));
  for (const { p, node, ci, spanning } of items) {
    const natural = Math.round((pg.h - p.y - p.h) * scale);
    const base = spanning ? Math.min(...cursor) : cursor[ci];
    const top = Math.max(natural, base);
    node.style.top = top + 'px';
    let hgt = node.offsetHeight || Math.round(p.h * scale);
    /* 行距补偿：译文比原文短时按行拉伸行距，使每块占位与原段一致（版式对齐、不留空洞） */
    if (TEXT_TYPES.includes(p.type) && p.h > 4) {
      const targetH = p.h * scale;
      if (hgt < targetH * 0.9 && hgt > 0) {
        const fs = parseFloat(node.style.fontSize) || 9;
        let lh = parseFloat(getComputedStyle(node).lineHeight);
        if (!isFinite(lh) || lh <= 0) lh = fs * 1.5;
        const lines = Math.max(1, Math.round(hgt / lh));
        const want = targetH / lines;
        if (want > lh && want <= fs * 2.6) {
          node.style.lineHeight = want.toFixed(2) + 'px';
          hgt = node.offsetHeight || hgt;
        }
      }
    }
    if (spanning) { for (let k = 0; k < cursor.length; k++) cursor[k] = Math.max(cursor[k], top + hgt + 3); }
    else cursor[ci] = top + hgt + 3;
  }
  el.style.height = Math.max(Math.round(pg.h * scale), Math.max(...cursor) + 16) + 'px';
  return el;
}

function zhBlockNode(p, scale, fs) {
  fs = fs || 1;
  const node = document.createElement('div');
  node.className = 'blk zh-blk ' + (p.type === 'heading' ? 'zh-h' + (p.level || 2) : 'zh-' + p.type);
  node.dataset.i = p.i;
  node.style.fontSize = Math.max(5.6, Math.min(20, (p.size || 9) * scale * 1.02 * fs)) + 'px';
  if (p.type === 'heading') {
    node.style.lineHeight = '1.35';
  } else {
    node.style.lineHeight = '1.5';
  }
  if (p.type === 'figure' || p.type === 'formula' || p.type === 'table') {
    const r = regionOf(p);
    const url = cropUrl(r);
    node.style.fontSize = '';
    if (!r && p.text) {
      node.classList.add('zh-formula-text');
      const f = document.createElement('div');
      f.className = 'formula-body';
      f.textContent = p.text;
      node.appendChild(f);
      return node;
    }
    if (url) {
      const img = document.createElement('img');
      img.className = 'zh-media';
      img.dataset.region = p.region;
      img.src = url;
      img.alt = '图表';
      /* 按原始区域尺寸精确落位，避免被拉伸/压缩变形 */
      img.style.width = Math.max(8, p.w * scale) + 'px';
      img.style.height = Math.max(6, p.h * scale) + 'px';
      node.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'media-ph';
      ph.dataset.region = p.region;
      ph.style.height = Math.max(24, p.h * scale) + 'px';
      ph.innerHTML = `<span>正在截取${p.type === 'table' ? '表格' : p.type === 'formula' ? '公式' : '插图'}…</span>`;
      node.appendChild(ph);
    }
    return node;
  }
  const txt = document.createElement('div');
  txt.className = 't-zh';
  txt.dataset.side = 'zh';
  txt.dataset.i = p.i;
  if (p.zh && String(p.zh).trim()) {
    txt.textContent = p.type === 'list' ? stripMarker(p.zh, p.marker) : p.zh;
  } else {
    txt.classList.add('pending');
    txt.textContent = '（待翻译）';
  }
  if (p.type === 'list') {
    const dot = document.createElement('span');
    dot.className = 'li-dot';
    dot.textContent = p.marker || '·';
    node.appendChild(dot);
    txt.classList.add('li-body');
  }
  if (p.type === 'caption') node.classList.add('zh-caption');
  node.appendChild(txt);
  return node;
}

/* 对照栏显隐 */
export function applyColVisibility() {
  const l = document.querySelector('#reader-content .pcol:first-child');
  const r = document.querySelector('#reader-content .pcol:last-child');
  if (l) l.style.display = store.showOrigCol === false ? 'none' : '';
  if (r) r.style.display = store.showZhCol === false ? 'none' : '';
}
