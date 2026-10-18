/**
 * settings.js - 设置中心：API 配置（文献处理与问答独立）、外观主题素材、数据存储
 */
import { $, $$, esc, toast, applyTheme, store, api, inputDialog } from './core.js';

let currentTheme = null;
let overrideDraft = {};

export function initSettings(onThemeChanged) {
  openModalEvents();
  apiTabEvents();
  themeTabEvents(onThemeChanged);
  storageTabEvents();
}

/* ---------------- 弹窗开关与 Tab ---------------- */
function openModalEvents() {
  $('#btn-settings').onclick = () => { $('#modal-mask').hidden = false; fillForms(); refreshStorage(); };
  $('#btn-modal-close').onclick = () => { $('#modal-mask').hidden = true; };
  $('#modal-mask').addEventListener('mousedown', e => { if (e.target === $('#modal-mask')) $('#modal-mask').hidden = true; });
  $$('.mtab').forEach(t => t.onclick = () => {
    $$('.mtab').forEach(x => x.classList.toggle('active', x === t));
    $$('.mtab-pane').forEach(p => p.classList.toggle('active', p.dataset.mpane === t.dataset.mtab));
  });
}

/* ---------------- API 配置 ---------------- */
function apiTabEvents() {
  for (const group of ['process', 'chat']) {
    const card = $('#cfg-' + group);
    card.querySelector('.test-btn').onclick = async () => {
      const btn = card.querySelector('.test-btn');
      btn.disabled = true; btn.textContent = '测试中…';
      // 先保存表单里的 baseUrl/model，便于用当前填写值测试
      await collectAndSave(true);
      const r = await api.testConfig(group);
      btn.disabled = false; btn.textContent = '测试连接';
      if (r.ok) toast(`【${group === 'process' ? '文献处理' : 'AI 问答'}】API 连接成功：${r.reply}`, 'ok', 3200);
      else toast(`连接失败：${r.error}`, 'err', 4200);
    };
  }
}
function fillForms() {
  const c = store.config;
  for (const group of ['process', 'chat']) {
    const card = $('#cfg-' + group);
    card.querySelector('[name=baseUrl]').value = c[group].baseUrl || '';
    const keyInput = card.querySelector('[name=apiKey]');
    keyInput.value = '';
    keyInput.placeholder = c[group].hasKey ? `已配置（${c[group].keyPreview}），留空保持不变` : 'sk-...';
    card.querySelector('[name=model]').value = c[group].model || '';
    card.querySelector('[name=reasoningModel]').value = c[group].reasoningModel || '';
    const st = card.querySelector('.key-state');
    st.textContent = c[group].hasKey ? `✔ 已配置 Key（${c[group].keyPreview}）` : '⚠ 未配置 Key';
    st.style.color = c[group].hasKey ? '' : '#dc2626';
    if (group === 'chat') card.querySelector('[name=intensity]').value = c.chat.intensity || 'standard';
  }
}
async function collectAndSave(silent) {
  const patch = {};
  for (const group of ['process', 'chat']) {
    const card = $('#cfg-' + group);
    const g = {};
    const baseUrl = card.querySelector('[name=baseUrl]').value.trim();
    const model = card.querySelector('[name=model]').value.trim();
    const reasoningModel = card.querySelector('[name=reasoningModel]').value.trim();
    const apiKey = card.querySelector('[name=apiKey]').value.trim();
    if (baseUrl) g.baseUrl = baseUrl;
    if (model) g.model = model;
    if (reasoningModel) g.reasoningModel = reasoningModel;
    if (apiKey) g.apiKey = apiKey;
    if (group === 'chat') g.intensity = card.querySelector('[name=intensity]').value;
    if (Object.keys(g).length) patch[group] = g;
  }
  if (!Object.keys(patch).length) return;
  const r = await api.saveConfig(patch);
  store.config = r.config;
  if (!silent) { fillForms(); toast('API 配置已保存', 'ok'); }
}

/* ---------------- 外观主题 ---------------- */
function themeTabEvents(onThemeChanged) {
  renderThemePresets();
  $('#theme-input').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const t = JSON.parse(text);
      const r = await api.importTheme(t);
      store.themes.push(r.theme);
      renderThemePresets();
      toast(`主题「${r.theme.name}」已导入`, 'ok');
    } catch (err) { toast('导入失败：' + err.message, 'err'); }
    e.target.value = '';
  });
  $('#bg-input').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await api.uploadBg(f);
      store.config.theme.bgImage = '/media/theme/bg.' + (f.name.split('.').pop().toLowerCase());
      await applyCurrentTheme();
      refreshBgState();
      toast('背景图片已应用', 'ok');
    } catch (err) { toast('背景设置失败：' + err.message, 'err'); }
    e.target.value = '';
  });
  $('#btn-bg-pick').onclick = () => $('#bg-input').click();
  $('#btn-bg-clear').onclick = async () => {
    await api.clearBg();
    store.config.theme.bgImage = '';
    await applyCurrentTheme();
    refreshBgState();
  };
  $('#font-scale').addEventListener('input', async e => {
    const v = parseFloat(e.target.value);
    $('#font-scale-val').textContent = Math.round(v * 100) + '%';
    store.config.fontScale = v;
    await applyCurrentTheme();
    clearTimeout(themeTabEvents._t);
    themeTabEvents._t = setTimeout(() => api.saveConfig({ fontScale: v }).catch(() => {}), 400);
  });
  // 自定义颜色
  $$('.theme-override input[type=color]').forEach(inp => {
    inp.addEventListener('input', async () => {
      overrideDraft[inp.dataset.ov] = inp.value;
      store.config.theme.overrides = { ...store.config.theme.overrides, ...overrideDraft };
      await applyCurrentTheme();
      clearTimeout(inp._t);
      inp._t = setTimeout(() => api.saveConfig({ theme: { overrides: store.config.theme.overrides } }).catch(() => {}), 500);
    });
  });
}
function renderThemePresets() {
  const wrap = $('#theme-presets');
  wrap.innerHTML = (store.themes || []).map(t => {
    const vars = t.vars || {};
    const preview = `<div class="tp" style="background:${vars['--bg'] || '#fff'}">
      <div style="height:14px;background:${vars['--topbar'] || '#eee'};border-bottom:1px solid ${vars['--border'] || '#ddd'}"></div>
      <div style="display:flex;gap:4px;padding:6px">
        <div style="flex:1;background:${vars['--panel'] || '#fff'};border-radius:4px;border:1px solid ${vars['--border'] || '#ddd'}"></div>
        <div style="flex:1;background:${vars['--accent'] || '#36c'};border-radius:4px"></div>
        <div style="flex:1;background:${vars['--panel'] || '#fff'};border-radius:4px;border:1px solid ${vars['--border'] || '#ddd'}"></div>
      </div></div>`;
    const active = store.config.theme.active === t.id ? ' active' : '';
    return `<div class="theme-card${active}" data-id="${t.id}">${preview}<div class="tn"><span>${esc(t.name)}</span>${active ? '<span style="color:var(--accent)">✓</span>' : ''}</div></div>`;
  }).join('') + `<div class="theme-card" id="card-import" style="display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px">＋ 导入主题包</div>`;
  wrap.querySelectorAll('.theme-card[data-id]').forEach(card => {
    card.onclick = async () => {
      store.config.theme.active = card.dataset.id;
      store.config.theme.overrides = {};
      overrideDraft = {};
      await api.saveConfig({ theme: { active: card.dataset.id, overrides: {} } });
      await applyCurrentTheme();
      renderThemePresets();
      $$('.theme-override input[type=color]').forEach(i => i.value = '');
      toast('主题已切换', 'ok', 1400);
    };
  });
  const imp = $('#card-import');
  if (imp) imp.onclick = () => $('#theme-input').click();
}
async function applyCurrentTheme() {
  const t = store.themes.find(x => x.id === store.config.theme.active) || store.themes[0];
  currentTheme = t;
  applyTheme(t, { ...store.config.theme.overrides, '--bg-image': store.config.theme.bgImage ? `url('${store.config.theme.bgImage}')` : 'none' }, store.config.fontScale);
  if (typeof onThemeChanged === 'function') onThemeChanged();
}
function refreshBgState() {
  $('#bg-state').textContent = store.config.theme.bgImage ? '已设置背景图' : '未设置';
}

/* ---------------- 数据存储 ---------------- */
function storageTabEvents() {
  $('#btn-dataroot-change').onclick = async () => {
    let dir = null;
    if (window.paperlensDesktop && window.paperlensDesktop.pickFolder) {
      // 桌面端：打开系统原生文件夹浏览对话框
      const r = await window.paperlensDesktop.pickFolder(store.config.dataRoot || '');
      if (!r || r.canceled) return;
      if (!r.ok || !r.path) { toast('选择失败：' + (r.error || '未知错误'), 'err', 3200); return; }
      dir = r.path;
    } else {
      // 浏览器模式：文本输入兜底
      dir = await inputDialog({
        title: '修改数据目录',
        label: '输入新的数据目录绝对路径（建议 E 盘）。\n修改后新数据将写入新目录，原目录数据保留不受影响。',
        value: store.config.dataRoot || '',
        placeholder: 'E:\\PaperLensData'
      });
      if (dir === null || !dir.trim()) return;
      dir = dir.trim();
    }
    if (dir === store.config.dataRoot) { toast('新目录与当前目录相同，无需修改', '', 2200); return; }
    if (!confirm('确认将数据目录修改为：\n' + dir + '\n\n修改后新数据将写入新目录，原目录数据保留不受影响。')) return;
    try {
      const r = await api.setDataroot(dir);
      store.config.dataRoot = r.dataRoot;
      $('#data-root').textContent = r.dataRoot;
      toast('数据目录已修改：' + r.dataRoot, 'ok', 3400);
      refreshStorage();
    } catch (e) { toast('修改失败：' + e.message, 'err'); }
  };
  $('#btn-open-folder').onclick = async () => {
    const target = store.config.dataRoot || '';
    if (window.paperlensDesktop && window.paperlensDesktop.openPath) {
      try {
        const r = await window.paperlensDesktop.openPath(target);
        if (r && r.ok === false) toast('打开失败：' + (r.error || '未知错误'), 'err', 3600);
      } catch (e) { toast('打开失败：' + e.message, 'err'); }
    } else {
      // 浏览器模式：复制路径兜底
      try { await navigator.clipboard.writeText(target); toast('已复制数据目录路径：' + target, 'ok', 3600); }
      catch (e) { toast('数据目录：' + target, '', 4200); }
    }
  };
}
async function refreshStorage() {
  $('#data-root').textContent = store.config.dataRoot || '';
  try {
    const s = await api.stats();
    const kb = s.bytes;
    $('#data-size').textContent = '占用：' + (kb < 1048576 ? (kb / 1024).toFixed(1) + ' KB' : kb < 1073741824 ? (kb / 1048576).toFixed(1) + ' MB' : (kb / 1073741824).toFixed(2) + ' GB');
  } catch (e) {}
  refreshBgState();
  $('#font-scale').value = store.config.fontScale || 1;
  $('#font-scale-val').textContent = Math.round((store.config.fontScale || 1) * 100) + '%';
  // 回填自定义颜色
  $$('.theme-override input[type=color]').forEach(inp => {
    const v = (store.config.theme.overrides || {})[inp.dataset.ov];
    if (v) inp.value = v;
  });
}
