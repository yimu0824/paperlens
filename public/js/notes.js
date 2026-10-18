/**
 * notes.js - ② 实时笔记与智能纪要区
 *  实时笔记：承接阅读区转入的标注，批注实时双向同步，含时间戳
 *  智能纪要：AI 流式生成，与文件绑定
 */
import { $, $$, esc, toast, fmtTime, store, api } from './core.js';
import { HL_COLORS, locateAnnotation, persistAnnotations } from './reader.js';

export function initNotesPanel() {
  // Tab 切换
  $$('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      $$('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      $$('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
      if (btn.dataset.tab === 'notes') refreshNotes();
      else refreshSummaryUI();
    };
  });
  $('#btn-summary').onclick = generateSummary;
}

/* ================= 实时笔记 ================= */
export function refreshNotes(opts = {}) {
  const s = store.current;
  const list = $('#notes-list');
  const tip = $('#notes-tip');
  if (!s) {
    tip.style.display = '';
    list.innerHTML = '';
    return;
  }
  const notes = store.annotations.filter(a => a.transferredAt)
    .sort((a, b) => (b.transferredAt || 0) - (a.transferredAt || 0));
  tip.style.display = notes.length ? 'none' : '';
  if (!notes.length) {
    tip.innerHTML = `《${esc(s.name)}》暂无转入的笔记。<br>在左侧阅读区选中文字 → 点击「⇥ 转入笔记」，即可在此记录想法，批注实时同步到原文。`;
    list.innerHTML = '';
    return;
  }
  list.innerHTML = notes.map(a => `
    <div class="note-card" data-ann="${a.id}" style="border-left-color:${HL_COLORS[a.color] || HL_COLORS.yellow}">
      <div class="nq">“${esc(String(a.quote || '').slice(0, 200))}${(a.quote || '').length > 200 ? '…' : ''}”</div>
      ${a.counterpart ? `<div class="nq2">${esc(String(a.counterpart).slice(0, 160))}${(a.counterpart || '').length > 160 ? '…' : ''}</div>` : ''}
      <textarea placeholder="在这里写下你的想法…（自动保存并同步到原文批注栏）">${esc(a.note || '')}</textarea>
      <div class="nmeta">
        <span>转入 ${fmtTime(a.transferredAt)} · 批注完成 ${a.noteUpdatedAt ? fmtTime(a.noteUpdatedAt) : '—'}</span>
        <span class="ops">
          <a data-op="locate">定位原文</a>
          <a data-op="untransfer">移出笔记</a>
          <a data-op="del" class="op-del">删除</a>
        </span>
      </div>
    </div>`).join('');

  // 事件绑定
  list.querySelectorAll('.note-card').forEach(card => {
    const id = card.dataset.ann;
    const a = store.annotations.find(x => x.id === id);
    if (!a) return;
    const ta = card.querySelector('textarea');
    ta.addEventListener('input', debounce(async () => {
      a.note = ta.value;
      a.noteUpdatedAt = a.note.trim() ? Date.now() : a.noteUpdatedAt;
      await persistAnnotations();
      // 实时同步到阅读区
      const { applyAllHighlights, renderGutter } = await import('./reader.js');
      applyAllHighlights(); renderGutter();
      const meta = card.querySelector('.nmeta span');
      if (meta) meta.innerHTML = `转入 ${fmtTime(a.transferredAt)} · 批注完成 ${a.noteUpdatedAt ? fmtTime(a.noteUpdatedAt) : '—'}`;
    }, 450));
    card.querySelector('[data-op="locate"]').onclick = () => locateAnnotation(id);
    card.querySelector('[data-op="untransfer"]').onclick = async () => {
      a.transferredAt = null;
      await persistAnnotations();
      refreshNotes();
      const { renderGutter } = await import('./reader.js');
      renderGutter();
      toast('已移出笔记（原文标注保留）', '', 1600);
    };
    card.querySelector('[data-op="del"]').onclick = async () => {
      if (!confirm('删除该条笔记及原文对应标注？')) return;
      store.annotations = store.annotations.filter(x => x.id !== id);
      await persistAnnotations();
      refreshNotes();
      const { applyAllHighlights, renderGutter } = await import('./reader.js');
      applyAllHighlights(); renderGutter();
    };
  });

  if (opts.focusNew) {
    const card = list.querySelector(`.note-card[data-ann="${opts.focusNew}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('note-saved-flash');
      const ta = card.querySelector('textarea');
      setTimeout(() => ta.focus(), 350);
    }
  }
}

/* ================= 智能纪要 ================= */
export async function refreshSummaryUI() {
  const s = store.current;
  const body = $('#summary-body');
  const btn = $('#btn-summary');
  const meta = $('#summary-meta');
  if (!s) {
    btn.disabled = true;
    meta.textContent = '';
    body.innerHTML = '<div class="pane-tip dim">请先在左侧打开一篇文献。</div>';
    return;
  }
  const sum = store.summaryText ? { text: store.summaryText, generatedAt: store.summaryMeta && store.summaryMeta.generatedAt } : null;
  btn.disabled = false;
  btn.textContent = sum ? '↻ 重新生成' : '✦ 生成智能纪要';
  meta.textContent = sum ? `生成于 ${fmtTime(sum.generatedAt)}` : '';
  body.innerHTML = sum
    ? `<div class="md-body">${render(sum.text)}</div>`
    : '<div class="pane-tip dim">尚未生成纪要。点击上方「生成智能纪要」，AI 将分析全文并输出结构化纪要（背景、方法、结果、结论、阅读建议）。</div>';
}
function render(md) { return window.__renderMD(md); }

async function generateSummary() {
  const s = store.current;
  if (!s) return toast('请先打开文献', 'err');
  const body = $('#summary-body');
  const btn = $('#btn-summary');
  btn.disabled = true;
  body.innerHTML = '<div class="pane-tip dim">⏳ 正在连接模型，开始流式生成…</div>';
  store.summaryText = '';
  try {
    await window.__consumeSSE(`/api/files/${s.id}/summary`, {}, {
      delta: j => {
        store.summaryText += j.piece;
        body.innerHTML = `<div class="md-body cursor-blink">${window.__renderMD(store.summaryText)}</div>`;
        body.scrollTop = body.scrollHeight;
      },
      done: j => {
        store.summaryMeta = { generatedAt: j.generatedAt };
      },
      error: e => { throw new Error(e.message); }
    });
    $('#summary-meta').textContent = `生成于 ${fmtTime(store.summaryMeta && store.summaryMeta.generatedAt)}`;
    body.innerHTML = `<div class="md-body">${window.__renderMD(store.summaryText)}</div>`;
    toast('智能纪要已生成并与文献绑定', 'ok');
  } catch (e) {
    body.innerHTML = `<div class="pane-tip" style="color:#dc2626">生成失败：${esc(e.message)}</div>`;
    toast('纪要生成失败：' + e.message, 'err', 4000);
  }
  btn.disabled = false;
  btn.textContent = '↻ 重新生成';
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
