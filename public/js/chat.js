/**
 * chat.js - ③ AI 问答检索区：流式对话、思考强度、文档上下文、历史会话（自动留痕+选择性保存）
 */
import { $, $$, esc, uid, toast, fmtTime, renderMD, consumeSSE, store, api } from './core.js';

let controller = null;
let streaming = false;
let sessionId = uid();      // 当前会话 id（历史记录主键）
let sessionSaved = false;   // 当前会话是否被用户标记保存

export function initChat() {
  const input = $('#chat-input');
  const send = $('#btn-chat-send');
  const stop = $('#btn-chat-stop');

  send.onclick = () => sendMessage();
  stop.onclick = () => { if (controller) controller.abort(); };
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;   // 中文输入法组合中，勿拦截回车
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(130, input.scrollHeight) + 'px';
  });
  $('#btn-chat-new').onclick = () => {
    sessionId = uid(); sessionSaved = false;
    store.chatMessages = [];
    $('#chat-msgs').innerHTML = `<div class="chat-empty dim">
      <p>👋 已开启新会话，直接向我提问：</p>
      <ul><li>这篇文献的核心贡献是什么？</li><li>用通俗语言解释第 3 节的方法</li><li>帮我梳理相关工作的研究脉络</li></ul></div>`;
  };
  // 历史会话面板
  $('#btn-chat-history').onclick = openHistory;
  $('#btn-chat-history-close').onclick = closeHistory;
  $('#btn-chat-save-current').onclick = async () => {
    if (!store.chatMessages.length) { toast('当前会话还没有内容', '', 1800); return; }
    sessionSaved = true;
    await persistSession();
    renderHistory();
    toast('当前会话已保存，不会被自动清理', 'ok', 2200);
  };
  $('#btn-chat-clear-unsaved').onclick = async () => {
    if (!confirm('确定清空所有「未保存」的历史会话？已标记保存的不受影响。')) return;
    try { await api.chatsClearUnsaved(); renderHistory(); toast('已清空未保存会话', 'ok', 1800); }
    catch (e) { toast('操作失败：' + e.message, 'err'); }
  };
  // 示例问题点击
  $('#chat-msgs').addEventListener('click', e => {
    const li = e.target.closest('.chat-empty li');
    if (li) { input.value = li.textContent; input.focus(); }
  });
  // 恢复默认思考强度
  const sel = $('#chat-intensity');
  if (store.config && store.config.chat && store.config.chat.intensity) sel.value = store.config.chat.intensity;
  sel.addEventListener('change', () => api.saveConfig({ chat: { intensity: sel.value } }).catch(() => {}));
}

async function sendMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || streaming) return;
  if (!store.config) return;
  const chatCfg = store.config.chat || {};
  if (!chatCfg.hasKey) {
    toast('未配置问答 API Key，请先在 ⚙ 设置中配置', 'err', 3600);
    return;
  }
  input.value = ''; input.style.height = 'auto';

  store.chatMessages.push({ role: 'user', content: text });
  appendMsg('user', esc(text));
  const aiEl = appendMsg('ai', '<span class="dim">思考中…</span>');
  setStreaming(true);

  controller = new AbortController();
  let acc = '';
  try {
    await consumeSSE('/api/chat', {
      messages: store.chatMessages.filter(m => m.role === 'user' || m.role === 'assistant'),
      intensity: $('#chat-intensity').value,
      useDoc: $('#chat-use-doc').checked,
      fileId: store.current ? store.current.id : ''
    }, {
      meta: j => {
        const names = { fast: '快速', standard: '标准', deep: '深度思考' };
        $('#chat-model-line').textContent = `模型：${j.model} · 思考强度：${names[j.intensity] || j.intensity}`;
      },
      delta: j => {
        acc += j.piece;
        aiEl.innerHTML = renderMD(acc);
        scrollBottom();
      },
      error: e => { throw new Error(e.message); }
    }, controller.signal);
    if (!acc) { aiEl.innerHTML = '<span class="dim">（模型未返回内容）</span>'; }
    store.chatMessages.push({ role: 'assistant', content: acc });
  } catch (e) {
    if (e.name === 'AbortError') {
      aiEl.innerHTML += '<div class="dim">（已停止生成）</div>';
      if (acc) store.chatMessages.push({ role: 'assistant', content: acc });
    } else {
      aiEl.innerHTML = `<span class="err">⚠ ${esc(e.message)}</span>`;
      toast('问答失败：' + e.message, 'err', 4000);
    }
  }
  setStreaming(false);
  controller = null;
  scrollBottom();
  persistSession();   // 每轮问答后自动留痕
}

/* ---------------- 历史会话 ---------------- */
function sessionTitle() {
  const firstUser = store.chatMessages.find(m => m.role === 'user');
  return firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 32) : '未命名会话';
}
async function persistSession() {
  if (!store.chatMessages.length) return;
  try {
    await api.chatsSave({
      id: sessionId, title: sessionTitle(),
      fileId: store.current ? store.current.id : '',
      fileName: store.current ? store.current.name : '',
      messages: store.chatMessages, saved: sessionSaved, updatedAt: Date.now()
    });
  } catch (e) { /* 历史保存失败不提示，避免打断对话 */ }
}
async function openHistory() {
  $('#chat-msgs').hidden = true;
  const h = $('#chat-history');
  h.hidden = false; h.classList.add('open');
  renderHistory();
}
function closeHistory() {
  $('#chat-history').hidden = true;
  $('#chat-history').classList.remove('open');
  $('#chat-msgs').hidden = false;
}
async function renderHistory() {
  const box = $('#chat-history-list');
  let list = [];
  try { list = await api.chatsList(); } catch (e) { box.innerHTML = `<div class="dim" style="padding:20px;text-align:center">加载失败：${esc(e.message)}</div>`; return; }
  if (!list.length) { box.innerHTML = '<div class="dim" style="padding:24px;text-align:center;line-height:1.8">暂无历史会话<br>每次问答会自动留痕在这里，重要内容可标记保存</div>'; return; }
  box.innerHTML = list.map(s => `
    <div class="ch-item" data-id="${esc(s.id)}">
      <div class="ch-main">
        <div class="ch-title">${esc(s.title || '未命名会话')}</div>
        <div class="ch-meta">
          <span>${fmtTime(s.updatedAt).slice(5, 16)}</span>
          <span>${(s.messages || []).length} 条</span>
          ${s.fileName ? `<span title="${esc(s.fileName)}">📄 ${esc(s.fileName.length > 12 ? s.fileName.slice(0, 12) + '…' : s.fileName)}</span>` : ''}
          <a class="ch-star ${s.saved ? 'saved' : ''}" data-op="star" title="${s.saved ? '已保存（点击取消）' : '标记保存，不会被自动清理'}">${s.saved ? '★ 已保存' : '☆ 保存'}</a>
          <a data-op="del" class="op-del">删除</a>
        </div>
      </div>
    </div>`).join('');
  box.querySelectorAll('.ch-item').forEach(item => {
    item.onclick = async e => {
      const op = e.target.dataset.op;
      const s = list.find(x => x.id === item.dataset.id);
      if (!s) return;
      if (op === 'star') {
        try { await api.chatsToggle(s.id, !s.saved); renderHistory(); } catch (err) { toast('操作失败：' + err.message, 'err'); }
        return;
      }
      if (op === 'del') {
        if (!confirm('删除该条会话记录？')) return;
        try {
          await api.chatsDelete(s.id);
          if (s.id === sessionId) { sessionId = uid(); sessionSaved = false; }
          renderHistory();
        } catch (err) { toast('删除失败：' + err.message, 'err'); }
        return;
      }
      /* 载入该会话 */
      store.chatMessages = (s.messages || []).slice();
      sessionId = s.id; sessionSaved = !!s.saved;
      const m = $('#chat-msgs');
      m.innerHTML = '';
      store.chatMessages.forEach(msg => appendMsg(msg.role === 'user' ? 'user' : 'ai', msg.role === 'user' ? esc(msg.content) : renderMD(msg.content)));
      closeHistory();
      toast('已载入历史会话，可继续提问', 'ok', 1800);
    };
  });
}

function appendMsg(role, html) {
  const empty = $('#chat-msgs .chat-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  el.innerHTML = html;
  $('#chat-msgs').appendChild(el);
  scrollBottom();
  return el;
}
function setStreaming(v) {
  streaming = v;
  $('#btn-chat-send').hidden = v;
  $('#btn-chat-stop').hidden = !v;
}
function scrollBottom() {
  const m = $('#chat-msgs');
  m.scrollTop = m.scrollHeight;
}
