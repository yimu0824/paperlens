/**
 * core.js - 全局状态、后端桥接、SSE 流解析、Markdown 渲染、通用 UI 工具
 */
export const $ = s => document.querySelector(s);
export const $$ = s => Array.from(document.querySelectorAll(s));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2));
export const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

/* ---------------- 全局状态 ---------------- */
export const store = {
  config: null, themes: [], files: [],
  current: null,            // 当前打开文件的 {id,name,hash,lang,...}
  paragraphs: [],           // 当前文件段落
  annotations: [],          // 当前文件标注（划线+批注+转入 统一实体）
  showZh: true, showGutter: true,
  summaryText: '', summaryMeta: null,
  chatMessages: [],         // {role:'user'|'assistant', content}
};

/* ---------------- Toast ---------------- */
export function toast(msg, type = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

/* ---------------- 后端请求 ---------------- */
async function handleResp(r) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.error) || `请求失败 (${r.status})`);
  if (j && j.error) throw new Error(j.error);
  return j || {};
}
export const api = {
  bootstrap: () => fetch('/api/bootstrap').then(handleResp),
  saveConfig: patch => fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(handleResp),
  testConfig: group => fetch('/api/config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group }) }).then(handleResp),
  upload: async (file, force) => {
    const buf = await file.arrayBuffer();
    const r = await fetch('/api/files/upload?force=' + (force ? '1' : '0'), {
      method: 'POST',
      headers: { 'x-pl-name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
      body: buf
    });
    return handleResp(r);
  },
  delFile: id => fetch('/api/files/' + id, { method: 'DELETE' }).then(handleResp),
  paragraphs: id => fetch(`/api/files/${id}/paragraphs`).then(handleResp),
  meta: id => fetch(`/api/files/${id}/meta`).then(handleResp),
  layout: id => fetch(`/api/files/${id}/layout`).then(handleResp),
  reanalyze: id => fetch(`/api/files/${id}/reanalyze`, { method: 'POST' }).then(handleResp),
  originalUrl: id => `/api/files/${id}/original`,
  annotations: id => fetch(`/api/files/${id}/annotations`).then(handleResp),
  saveAnnotations: (id, list) => fetch(`/api/files/${id}/annotations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) }).then(handleResp),
  getSummary: id => fetch(`/api/files/${id}/summary`).then(handleResp),
  exportInfo: () => fetch('/api/exports').then(handleResp),
  themes: () => fetch('/api/themes').then(handleResp),
  importTheme: t => fetch('/api/themes/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t) }).then(handleResp),
  uploadBg: async file => {
    const buf = await file.arrayBuffer();
    const ext = '.' + (file.name.split('.').pop() || 'png').toLowerCase();
    return fetch('/api/theme/bg', { method: 'POST', headers: { 'x-pl-ext': ext, 'Content-Type': 'application/octet-stream' }, body: buf }).then(handleResp);
  },
  clearBg: () => fetch('/api/theme/bg', { method: 'DELETE' }).then(handleResp),
  setDataroot: dir => fetch('/api/dataroot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) }).then(handleResp),
  stats: () => fetch('/api/stats').then(handleResp),
  exportFile: (id, force) => fetch(`/api/files/${id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force }) }).then(handleResp),
  chatsList: () => fetch('/api/chats').then(handleResp),
  chatsSave: s => fetch('/api/chats/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(handleResp),
  chatsToggle: (id, saved) => fetch('/api/chats/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, saved }) }).then(handleResp),
  chatsDelete: id => fetch('/api/chats/' + id, { method: 'DELETE' }).then(handleResp),
  chatsClearUnsaved: () => fetch('/api/chats/unsaved', { method: 'DELETE' }).then(handleResp),
};

/* ---------------- SSE 消费（POST 流式） ---------------- */
export async function consumeSSE(url, body, handlers, signal) {
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!r.ok || !r.body) { let j = {}; try { j = await r.json(); } catch (e) {} throw new Error(j.error || `请求失败 (${r.status})`); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep); buf = buf.slice(sep + 2);
      let event = 'message', data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let j; try { j = JSON.parse(data); } catch (e) { continue; }
      handlers[event] && handlers[event](j);
    }
  }
  handlers.__end && handlers.__end();
}

/* ---------------- 轻量 Markdown 渲染 ---------------- */
export function renderMD(src) {
  if (!src) return '';
  src = String(src).replace(/\r\n/g, '\n');
  const blocks = [];
  // 提取代码块
  src = src.replace(/```([\s\S]*?)```/g, (_, code) => {
    blocks.push('<pre><code>' + esc(code.replace(/^\w*\n/, '')) + '</code></pre>');
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  const lines = src.split('\n');
  const out = [];
  let list = null, table = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push('</tbody></table>'); table = null; } };
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent)">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bm = line.match(/^\u0000B(\d+)\u0000$/);
    if (bm) { closeList(); closeTable(); out.push(blocks[+bm[1]]); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (/^[\s:|-]+$/.test(line)) continue;
      if (!table) { closeList(); table = true; out.push('<table><tbody>'); }
      out.push('<tr>' + cells.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      continue;
    } else closeTable();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)/))) { if (list !== 'ul') { closeList(); list = 'ul'; out.push('<ul>'); } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+[.、)]\s+(.*)/))) { if (list !== 'ol') { closeList(); list = 'ol'; out.push('<ol>'); } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (/^\s*>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();
  return out.join('\n');
}

/* ---------------- 对话框（Electron 不支持 prompt，统一用自定义对话框） ---------------- */
function buildDialog(inner) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask dlg-mask';
  mask.innerHTML = `<div class="modal dlg-modal">${inner}</div>`;
  document.body.appendChild(mask);
  return mask;
}
/** 文本输入对话框，返回输入字符串；取消返回 null */
export function inputDialog({ title, label = '', value = '', placeholder = '', okText = '确定' }) {
  return new Promise(resolve => {
    const mask = buildDialog(`
      <div class="modal-head"><span class="modal-title">${esc(title)}</span></div>
      <div class="modal-body">
        ${label ? `<p class="dlg-label">${esc(label)}</p>` : ''}
        <input class="dlg-input" value="${esc(value)}" placeholder="${esc(placeholder)}">
      </div>
      <div class="dlg-foot"><button class="btn dlg-cancel">取消</button><button class="btn primary dlg-ok">${esc(okText)}</button></div>`);
    const input = mask.querySelector('.dlg-input');
    const done = v => { mask.remove(); resolve(v); };
    mask.querySelector('.dlg-ok').onclick = () => done(input.value.trim());
    mask.querySelector('.dlg-cancel').onclick = () => done(null);
    mask.addEventListener('mousedown', e => { if (e.target === mask) done(null); });
    input.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;   // 中文输入法组合中
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
    });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}
/** 选项对话框，返回所选 key；取消（遮罩/Esc）返回 null */
export function choiceDialog({ title, message = '', choices = [] }) {
  return new Promise(resolve => {
    const mask = buildDialog(`
      <div class="modal-head"><span class="modal-title">${esc(title)}</span></div>
      <div class="modal-body">${message ? `<p class="dlg-label">${message}</p>` : ''}
        <div class="dlg-choices">${choices.map(c =>
          `<button class="btn ${c.primary ? 'primary' : ''} dlg-choice" data-key="${esc(c.key)}">${esc(c.label)}</button>`).join('')}
        </div>
      </div>`);
    const done = v => { mask.remove(); resolve(v); };
    mask.querySelectorAll('.dlg-choice').forEach(b => b.onclick = () => done(b.dataset.key));
    mask.addEventListener('mousedown', e => { if (e.target === mask) done(null); });
    mask.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
  });
}

/* ---------------- IME（输入法）自愈 ----------------
 * Windows 下 Electron 窗口失焦再获焦后，输入法组合会话可能失效（打字无反应）。
 * 策略：①窗口重新获焦时自动重建当前输入框的会话（blur+focus，保留光标位置）；
 *      ②Ctrl+Alt+F 手动急救：立即重新激活当前输入框。
 */
export function initImeRescue() {
  const isEditable = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|color|range|file)$/.test(el.type || 'text')));
  const refresh = el => {
    try {
      const s = el.selectionStart, e2 = el.selectionEnd;
      el.blur(); el.focus();
      if (s != null) el.setSelectionRange(s, e2);
      return true;
    } catch (e) { return false; }
  };
  window.addEventListener('focus', () => {
    const el = document.activeElement;
    if (isEditable(el)) setTimeout(() => refresh(el), 120);
  });
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      const el = document.activeElement;
      if (isEditable(el) && refresh(el)) toast('已重新激活输入框，请再试一次', 'ok', 2000);
      else toast('请先点击要输入的框，再按 Ctrl+Alt+F', '', 2200);
    }
  }, true);
}

/* ---------------- 主题应用 ---------------- */
export function applyTheme(theme, overrides = {}, fontScale = 1) {
  const root = document.documentElement;
  const vars = (theme && theme.vars) || {};
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v) root.style.setProperty(k, v);
  }
  if (theme && theme.font) root.style.setProperty('--font-app', theme.font);
  const bg = theme && theme.vars ? theme.vars['--bg-image'] : 'none';
  root.style.setProperty('--bg-image', (overrides && overrides['--bg-image']) || 'none');
  root.style.setProperty('--font-size', Math.round(14 * (fontScale || 1)) + 'px');
}
