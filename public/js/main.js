/**
 * main.js - 启动引导：布局分割条、文件目录、上传/去重、打开文件、导出 PDF
 */
import { $, $$, esc, toast, fmtTime, store, api, applyTheme, consumeSSE, renderMD, choiceDialog, initImeRescue } from './core.js';
import { renderReader, initReaderEvents, persistAnnotations, translateAll, renderParallelView, renderOriginalView, drawOriginalTranslations, restoreDrawer, applyColVisibility, extractGraphicCrops } from './reader.js';
import { initNotesPanel, refreshNotes, refreshSummaryUI } from './notes.js';
import { initChat } from './chat.js';
import { initSettings } from './settings.js';

window.__renderMD = renderMD;
window.__consumeSSE = consumeSSE;

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    const b = await api.bootstrap();
    store.config = b.config;
    store.config.dataRoot = b.dataRoot;   // 数据根目录随 bootstrap 下发（config.json 本身不含此字段）
    store.themes = b.themes;
    store.files = b.files;
    if (window.paperlensDesktop) b.desktop = true;
    // 主题
    const theme = store.themes.find(t => t.id === store.config.theme.active) || store.themes[0];
    applyTheme(theme, { ...store.config.theme.overrides, '--bg-image': store.config.theme.bgImage ? `url('${store.config.theme.bgImage}')` : 'none' }, store.config.fontScale);
    // 布局
    applyLayout();
    initSplitters();
    initImeRescue();
    initReaderEvents();
    initNotesPanel();
    initChat();
    initSettings(async () => { /* 主题变化无需额外处理 */ });
    wireTopActions();
    renderFileList();
    // 恢复上次打开的文件
    const last = store.config.lastFileId && store.files.find(f => f.id === store.config.lastFileId);
    if (last) await openFile(last.id);
    else await renderReader();
  } catch (e) {
    toast('初始化失败：' + e.message, 'err', 5000);
    console.error(e);
  }
}

/* ---------------- 顶部动作 ---------------- */
function wireTopActions() {
  $('#btn-upload').onclick = () => $('#file-input').click();
  $('#file-input').addEventListener('change', e => { handleFiles(Array.from(e.target.files)); e.target.value = ''; });
  $('#btn-export').onclick = exportPdf;
  // 阅读区工具
  $('#btn-translate').onclick = () => translateAll();
  $('#btn-original').onclick = () => {
    if (!store.layout) return;
    if (store.viewMode === 'original') {
      store.viewMode = 'text';
      $('#btn-original').classList.remove('on');
      restoreDrawer();
      renderReader();
      return;
    }
    store.viewMode = 'original';
    $('#btn-original').classList.add('on');
    $('#btn-parallel').classList.remove('on');
    $('#parallel-tools').hidden = true;
    renderOriginalView();
  };
  $('#btn-parallel').onclick = () => {
    if (!store.layout) return;
    store.viewMode = store.viewMode === 'parallel' ? 'text' : 'parallel';
    $('#btn-parallel').classList.toggle('on', store.viewMode === 'parallel');
    $('#btn-original').classList.toggle('on', false);
    $('#parallel-tools').hidden = store.viewMode !== 'parallel';
    if (store.viewMode === 'parallel') renderParallelView();
    else { restoreDrawer(); renderReader(); }
  };
  $('#btn-col-orig').onclick = () => {
    store.showOrigCol = store.showOrigCol === false ? true : false;
    if (store.showOrigCol === false && store.showZhCol === false) {
      store.showOrigCol = true; toast('至少需要显示一个栏', '', 1800);
    }
    $('#btn-col-orig').classList.toggle('toggle-on', store.showOrigCol !== false);
    applyColVisibility();
  };
  $('#btn-col-zh').onclick = () => {
    store.showZhCol = store.showZhCol === false ? true : false;
    if (store.showOrigCol === false && store.showZhCol === false) {
      store.showZhCol = true; toast('至少需要显示一个栏', '', 1800);
    }
    $('#btn-col-zh').classList.toggle('toggle-on', store.showZhCol !== false);
    applyColVisibility();
  };
  $('#btn-zoom-in').onclick = () => {
    store.viewScale = Math.min(3, Math.round(((store.viewScale || 1) * 1.25) * 100) / 100);
    $('#zoom-val').textContent = Math.round((store.viewScale || 1) * 100) + '%';
    if (store.viewMode === 'parallel') renderParallelView();
    else if (store.viewMode === 'original') renderOriginalView();
  };
  $('#btn-zoom-out').onclick = () => {
    store.viewScale = Math.max(0.5, Math.round(((store.viewScale || 1) / 1.25) * 100) / 100);
    $('#zoom-val').textContent = Math.round((store.viewScale || 1) * 100) + '%';
    if (store.viewMode === 'parallel') renderParallelView();
    else if (store.viewMode === 'original') renderOriginalView();
  };
  $('#btn-toggle-zh').onclick = () => {
    store.showZh = !store.showZh;
    $('#btn-toggle-zh').style.opacity = store.showZh ? 1 : .45;
    if (store.viewMode === 'parallel') {
      store.showZhCol = store.showZh;
      $('#btn-col-zh').classList.toggle('toggle-on', store.showZhCol !== false);
      if (store.showOrigCol === false && store.showZhCol === false) { store.showOrigCol = true; $('#btn-col-orig').classList.add('toggle-on'); }
      applyColVisibility();
      return;
    }
    $('#reader-content').classList.toggle('hide-zh', !store.showZh);
    if (store.viewMode === 'original') drawOriginalTranslations();
  };
  $('#btn-gutter').onclick = async () => {
    store.showGutter = !store.showGutter;
    $('#reader-wrap').classList.toggle('no-gutter', !store.showGutter);
    const { renderGutter } = await import('./reader.js');
    renderGutter();
  };
  $('#btn-drawer').onclick = () => $('#zone-reader').classList.toggle('no-drawer');
  $('#file-search').addEventListener('input', () => renderFileList());
  // 拖拽导入
  const rw = $('#reader-wrap');
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#drop-hint').hidden = false; });
  window.addEventListener('dragleave', e => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('#drop-hint').hidden = true;
    handleFiles(Array.from(e.dataTransfer.files));
  });
}

/* ---------------- 文件目录 ---------------- */
function renderFileList() {
  const q = ($('#file-search').value || '').toLowerCase();
  const list = $('#file-list');
  const files = store.files.filter(f => !q || f.name.toLowerCase().includes(q));
  $('#file-count').textContent = store.files.length ? store.files.length + ' 篇' : '';
  if (!files.length) {
    list.innerHTML = `<div class="dim" style="padding:20px 10px;text-align:center;line-height:1.8">暂无文献<br>点击顶部「上传文献」或拖拽文件到窗口</div>`;
    return;
  }
  list.innerHTML = files.map(f => `
    <div class="file-item ${store.current && store.current.id === f.id ? 'active' : ''}" data-id="${f.id}">
      <div class="fi-name">
        <span style="flex:none">📄</span>
        <span style="overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(f.name)}</span>
        <span class="lang-tag">${f.lang === 'zh' ? '中' : 'EN'}</span>
      </div>
      <div class="fi-meta">
        <span>${fmtTime(f.addedAt).slice(5, 16)}</span>
        <span>${f.paragraphs}段</span>
        ${f.annotations ? `<span>标${f.annotations}</span>` : ''}
        ${f.notes ? `<span>笔${f.notes}</span>` : ''}
        ${f.hasSummary ? `<span title="已生成智能纪要">✦纪要</span>` : ''}
        <a class="fi-del" data-del="${f.id}" title="删除">✕</a>
      </div>
    </div>`).join('');
  list.querySelectorAll('.file-item').forEach(item => {
    item.onclick = e => {
      if (e.target.closest('.fi-del')) return;
      openFile(item.dataset.id);
    };
  });
  list.querySelectorAll('.fi-del').forEach(a => {
    a.onclick = async e => {
      e.stopPropagation();
      const f = store.files.find(x => x.id === a.dataset.del);
      if (!confirm(`确认删除《${f.name}》？\n该文件的标注、笔记与纪要将一并删除，原始上传文件不受影响。`)) return;
      await api.delFile(f.id);
      store.files = store.files.filter(x => x.id !== f.id);
      if (store.current && store.current.id === f.id) { store.current = null; store.paragraphs = []; store.annotations = []; store.summaryText = ''; await renderReader(); refreshNotes(); refreshSummaryUI(); }
      renderFileList();
      toast('已删除', 'ok', 1400);
    };
  });
}

/* ---------------- 上传与去重 ---------------- */
async function handleFiles(files) {
  for (const f of files) {
    const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
    if (!['.txt', '.md', '.markdown', '.pdf', '.docx'].includes(ext)) {
      toast(`不支持的格式：${f.name}（仅支持 txt/md/pdf/docx）`, 'err', 3600);
      continue;
    }
    let r;
    try { r = await api.upload(f, false); }
    catch (e) { toast(`上传失败：${f.name} — ${e.message}`, 'err', 4000); continue; }
    if (r.duplicate) {
      const existing = store.files.find(x => x.id === r.existing[0]);
      const choice = await choiceDialog({
        title: '检测到重复文件',
        message: `《${esc(f.name)}》与已有文件内容完全一致（按内容哈希识别）。` +
          (existing ? `\n已有：《${esc(existing.name)}》（导入于 ${fmtTime(existing.addedAt)}）` : '') +
          '\n\n如何处理？',
        choices: [
          { key: 'open', label: '📖 打开已有文件', primary: true },
          { key: 'new', label: '🆕 仍按全新文件导入（获得独立标注与纪要）' },
          { key: 'skip', label: '取消' }
        ]
      });
      if (choice === 'open') {
        if (existing) await openFile(existing.id);
        continue;
      } else if (choice === 'new') {
        try { r = await api.upload(f, true); }
        catch (e) { toast(`导入失败：${e.message}`, 'err'); continue; }
      } else continue;
    }
    // 成功导入
    store.files.unshift({
      id: r.id, name: r.meta.name, hash: r.meta.hash, addedAt: r.meta.addedAt, ext: r.meta.ext,
      paragraphs: r.meta.paragraphCount, lang: r.meta.lang, hasSummary: false,
      annotations: 0, notes: 0
    });
    renderFileList();
    await openFile(r.id);
    toast(`《${r.meta.name}》导入成功（${r.meta.paragraphCount} 段）${r.meta.lang === 'en' ? '，可点击「翻译全文」生成中英对照' : ''}`, 'ok', 4200);
  }
}

/* ---------------- 打开文件 ---------------- */
export async function openFile(id) {
  const f = store.files.find(x => x.id === id);
  if (!f) return;
  store.current = f;
  store.summaryText = '';
  store.summaryMeta = null;
  store.viewMode = 'text';
  store.layout = null;
  const btnPara = $('#btn-parallel');
  /* 对照视图只为外文文献提供译文；中文文献仅单语阅读 */
  const isZhDoc = f.lang === 'zh';
  btnPara.hidden = !(f.ext === '.pdf' && !isZhDoc);
  $('#btn-original').hidden = f.ext !== '.pdf';
  $('#btn-original').classList.remove('on');
  $('#btn-translate').hidden = isZhDoc;
  $('#btn-toggle-zh').hidden = isZhDoc;
  btnPara.classList.remove('on');
  $('#parallel-tools').hidden = true;
  store.viewScale = 1;
  $('#zoom-val').textContent = '100%';
  store.showOrigCol = true; store.showZhCol = true;
  $('#btn-col-orig').classList.add('toggle-on');
  $('#btn-col-zh').classList.add('toggle-on');
  /* 旧版导入的 PDF：按新版版面引擎重建结构（分栏 / 图片 / 表格 / 公式） */
  if (f.ext === '.pdf') {
    try {
      const meta = await api.meta(id);
      if (meta && meta.hasLayout && meta.layoutVersion !== 7) {
        toast('正在按新版版面引擎重新解析：修复分栏、图片与表格区域…', '', 5000);
        const rr = await api.reanalyze(id);
        if (rr && rr.ok) {
          const lost = rr.annotations && rr.annotations.lost;
          toast(`版面已重建（${rr.paragraphs} 个内容块）${lost ? `，${lost} 条标注因原文切分变化未能定位` : ''}`, 'ok', 4500);
        }
      }
    } catch (e) { /* 重新解析失败则按原数据打开 */ }
  }
  if (f.ext === '.pdf') {
    api.layout(id).then(l => {
      if (l && l.pages && l.pages.length) { store.layout = l; if (!isZhDoc) btnPara.hidden = false; extractGraphicCrops(); }
      else btnPara.hidden = true;
    }).catch(() => { btnPara.hidden = true; });
  }
  try {
    const tasks = [api.paragraphs(id), api.annotations(id), api.getSummary(id)];
    if (f.ext === '.pdf') tasks.push(api.layout(id).catch(() => null));
    const [paras, anns, sum, layout] = await Promise.all(tasks);
    store.paragraphs = paras;
    store.annotations = anns;
    if (sum && sum.text) { store.summaryText = sum.text; store.summaryMeta = sum; }
    if (layout && layout.pages && layout.pages.length) { store.layout = layout; if (!isZhDoc) btnPara.hidden = false; }
    else btnPara.hidden = true;
  } catch (e) {
    toast('读取文件失败：' + e.message, 'err');
    return;
  }
  /* 若加载期间用户已切到对照视图，按当前视图渲染，避免被回退成文本视图 */
  if (store.viewMode === 'parallel') await renderParallelView();
  else await renderReader();
  refreshNotes();
  refreshSummaryUI();
  renderFileList();
  api.saveConfig({ lastFileId: id }).catch(() => {});
}

/* ---------------- 导出 PDF ---------------- */
async function exportPdf() {
  const s = store.current;
  if (!s) return toast('请先打开要导出的文献', 'err');
  const hasAnns = store.annotations.length > 0;
  if (!hasAnns && !store.summaryText && !confirm('当前文献没有标注批注，也没有生成纪要。\n仍要导出 PDF 吗？')) return;
  let r;
  try { r = await api.exportFile(s.id, false); }
  catch (e) { return toast('导出失败：' + e.message, 'err', 4000); }
  if (r.duplicate) {
    const ok = confirm(
      `检测到重复导出：\n《${r.existing.name}》曾于 ${fmtTime(r.existing.time)} 导出过（内容一致）。\n\n确定要再次导出吗？`);
    if (!ok) return;
    try { r = await api.exportFile(s.id, true); }
    catch (e) { return toast('导出失败：' + e.message, 'err', 4000); }
  }
  // Electron 桌面端：静默生成 PDF；浏览器端：打开打印预览
  if (window.paperlensDesktop && window.paperlensDesktop.exportPDF) {
    toast('正在生成 PDF…', '', 4000);
    try {
      const out = await window.paperlensDesktop.exportPDF(r.htmlPath, r.pdfPath);
      if (out && out.ok) {
        toast(`PDF 已导出：${r.pdfName}`, 'ok', 4200);
        if (window.paperlensDesktop.openPath) window.paperlensDesktop.openPath(r.pdfPath);
      } else toast('PDF 生成失败', 'err');
    } catch (e) { toast('PDF 生成失败：' + e.message, 'err', 4000); }
  } else {
    window.open('/media/exports/' + encodeURIComponent(r.htmlName) + '?print=1', '_blank');
    toast('已打开打印预览：选择「另存为 PDF」即可保存（含标注批注与纪要）', 'ok', 5000);
  }
}

/* ---------------- 布局分割条 ---------------- */
function applyLayout() {
  const l = store.config.layout || {};
  if (l.c1) $('#zone-reader').style.flexBasis = l.c1 + '%';
  if (l.c2) $('#zone-notes').style.flexBasis = l.c2 + '%';
  $('#zone-reader').classList.toggle('no-drawer', l.drawer === false);
  $('#reader-wrap').classList.toggle('no-gutter', l.gutter === false);
}
function initSplitters() {
  const layout = $('#layout');
  const setup = (spId, zoneId, key, nextZoneId) => {
    const sp = $(spId), zone = $(zoneId);
    sp.addEventListener('mousedown', e => {
      e.preventDefault();
      sp.classList.add('active');
      const startX = e.clientX, startW = zone.getBoundingClientRect().width;
      const total = layout.getBoundingClientRect().width;
      const move = ev => {
        const w = Math.max(240, Math.min(total - 480, startW + ev.clientX - startX));
        zone.style.flex = `0 0 ${w}px`;
        zone.style.flexBasis = w + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        sp.classList.remove('active');
        const pct = +(zone.getBoundingClientRect().width / total * 100).toFixed(1);
        store.config.layout[key] = pct;
        api.saveConfig({ layout: { [key]: pct } }).catch(() => {});
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  };
  setup('#sp1', '#zone-reader', 'c1', '#zone-notes');
  setup('#sp2', '#zone-notes', 'c2', '#zone-chat');
}

boot();
