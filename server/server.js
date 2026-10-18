/**
 * PaperLens 论文研读台 - 本地服务
 * 纯 Node.js 实现，无框架依赖。可独立运行（node server/server.js），
 * 也可被 Electron 主进程 require 后调用 startServer()。
 *
 * 数据全部存储在 E 盘数据目录（默认 <项目>/data，可在设置中修改）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..');

/* ---------------- 运行时与数据目录 ----------------
 * 开发时：<项目>/config.runtime.json + <项目>/data
 * 打包后：由 Electron 主进程通过 startServer({ runtimeFile, baseDataDir }) 指定可写位置
 *        （默认 <exe 同级>/data，不可写则退回用户目录），避免往 app.asar 里写文件。 */
let RUNTIME_FILE = process.env.PL_RUNTIME_FILE || path.join(PROJECT_ROOT, 'config.runtime.json');
let BASE_DATA_DIR = process.env.PL_DATA_ROOT || path.join(PROJECT_ROOT, 'data');
function loadRuntime() {
  try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); } catch (e) { return {}; }
}
let RUNTIME = loadRuntime();
function saveRuntime() { try { fs.writeFileSync(RUNTIME_FILE, JSON.stringify(RUNTIME, null, 2)); } catch (e) {} }
function dataRoot() { return RUNTIME.dataRoot || BASE_DATA_DIR; }
function initPaths(opts) {
  if (opts && opts.runtimeFile) RUNTIME_FILE = opts.runtimeFile;
  if (opts && opts.baseDataDir) BASE_DATA_DIR = opts.baseDataDir;
  RUNTIME = loadRuntime();
}

function sub(...p) { return path.join(dataRoot(), ...p); }
async function ensureDirs() {
  for (const d of ['', 'library', 'files', 'exports', 'themes', path.join('themes', 'uploads')]) {
    await fsp.mkdir(sub(d), { recursive: true });
  }
}

/* ---------------- 配置 ---------------- */
const DEFAULT_CONFIG = {
  process: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', reasoningModel: 'deepseek-reasoner', temperature: 0.6 },
  chat: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', reasoningModel: 'deepseek-reasoner', intensity: 'standard' },
  theme: { active: 'blue-business', overrides: {}, bgImage: '' },
  layout: { c1: 30, c2: 33, drawer: true, gutter: true },
  fontScale: 1.0,
  lastFileId: ''
};
function configFile() { return sub('config.json'); }
async function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(await fsp.readFile(configFile(), 'utf8')); } catch (e) {}
  return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), cfg);
}
function deepMerge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') deepMerge(base[k], over[k]);
    else base[k] = over[k];
  }
  return base;
}
async function saveConfig(cfg) { await ensureDirs(); await fsp.writeFile(configFile(), JSON.stringify(cfg, null, 2), 'utf8'); }
function maskConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  for (const g of ['process', 'chat']) {
    if (c[g].apiKey) { c[g].hasKey = true; c[g].keyPreview = c[g].apiKey.slice(0, 3) + '****' + c[g].apiKey.slice(-4); }
    else { c[g].hasKey = false; c[g].keyPreview = ''; }
    delete c[g].apiKey;
  }
  return c;
}

/* ---------------- 工具 ---------------- */
function uid() { return crypto.randomUUID(); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function now() { return Date.now(); }
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('文件过大（限制 60MB）')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) { try { return JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString('utf8') || '{}'); } catch (e) { return {}; } }
function sseInit(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
}
function sseSend(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} }

/* ---------------- LLM 调用（OpenAI 兼容 / DeepSeek） ---------------- */
async function llmChat(group, { messages, stream = false, onDelta, signal, modelOverride, temperature } = {}) {
  const cfg = (await loadConfig())[group] || {};
  const baseUrl = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const key = cfg.apiKey;
  if (!key) { const err = new Error('尚未配置 API Key，请先在「设置 → API 配置」中填写'); err.noKey = true; throw err; }
  const body = {
    model: modelOverride || cfg.model || 'deepseek-chat',
    messages, stream: !!stream
  };
  if (temperature != null) body.temperature = temperature;
  else if (cfg.temperature != null) body.temperature = cfg.temperature;
  const r = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const err = new Error(`API 请求失败 (${r.status})：${t.slice(0, 300) || r.statusText}`);
    err.status = r.status; throw err;
  }
  if (!stream) {
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        const piece = (d && d.content) || '';
        if (piece) { full += piece; onDelta && onDelta(piece, full); }
      } catch (e) {}
    }
  }
  return full;
}

/* ---------------- 文档解析（txt / md / pdf / docx） ---------------- */
function isChinese(text) {
  if (!text) return false;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk / Math.max(1, text.replace(/\s/g, '').length) > 0.25;
}
async function extractParagraphs(buf, ext, name) {
  ext = ext.toLowerCase();
  let paras = [];
  let pdfLayout = null;
  if (ext === '.pdf') {
    const { analyzePdf } = require('./pdflayout.js');
    const r = await analyzePdf(buf);
    paras = r.paragraphs;
    pdfLayout = r.layout;
    if (!paras.some(p => p.type !== 'meta' && p.text)) throw new Error('该 PDF 未检测到有效文字层（可能为纯图片扫描版），请使用文字版 PDF 或先进行 OCR');
    const lang0 = isChinese(paras.map(p => p.text).join(' ').slice(0, 4000)) ? 'zh' : 'en';
    const out0 = paras.map(p => ({
      ...p,
      zh: (lang0 === 'zh' || p.type === 'meta' || p.type === 'formula' || p.type === 'figure') ? p.text : null,
      translatedAt: null
    }));
    return { paras: out0, layout: pdfLayout };
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    const text = buf.toString('utf8').replace(/\r\n/g, '\n');
    paras = text.split(/\n\s*\n/).map(s => s.replace(/\n/g, ' ').trim()).filter(Boolean)
      .map(t => ({ type: (ext !== '.txt' && /^#{1,6}\s/.test(t)) ? 'heading' : 'para', text: t.replace(/^#{1,6}\s*/, '') }));
  } else if (ext === '.docx') {
    const mammoth = require('mammoth');
    const { value: html } = await mammoth.convertToHtml({ buffer: buf });
    const parts = html.split(/<\/(p|h[1-6])>/i);
    for (const raw of parts) {
      const m = raw.match(/<h([1-6])[^>]*>([\s\S]*?)$/i);
      let type = 'para', inner = raw;
      if (m) { type = 'heading'; inner = m[2]; }
      const text = inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      if (text) paras.push({ type, text });
    }
  } else {
    throw new Error('暂不支持该格式，请上传 txt / md / pdf / docx 文件');
  }
  if (!paras.length) throw new Error('未能从文件中提取到文本内容');
  const lang = isChinese(paras.map(p => p.text).join(' ').slice(0, 4000)) ? 'zh' : 'en';
  const out = paras.map((p, i) => ({
    i, type: p.type, text: p.text,
    zh: lang === 'zh' ? p.text : null,   // 中文原文直接作为译文显示
    translatedAt: lang === 'zh' ? now() : null
  }));
  return { paras: out, layout: pdfLayout };
}
/* ---------------- 文件库 ---------------- */
async function readJSONFile(p, fallback) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch (e) { return fallback; } }
async function writeJSONFile(p, obj) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, JSON.stringify(obj, null, 2), 'utf8'); }
async function loadIndex() { return readJSONFile(sub('index.json'), {}); }   // { hash: [fileId...] }
async function saveIndex(idx) { await writeJSONFile(sub('index.json'), idx); }
async function fileDir(id) { return sub('files', id); }

async function listFiles() {
  const idx = await loadIndex();
  const ids = new Set(); Object.values(idx).forEach(a => a.forEach(i => ids.add(i)));
  const out = [];
  for (const id of ids) {
    const meta = await readJSONFile(path.join(await fileDir(id), 'meta.json'), null);
    if (meta) {
      const anns = await readJSONFile(path.join(await fileDir(id), 'annotations.json'), []);
      const notes = anns.filter(a => a.transferredAt).length;
      out.push({
        id, name: meta.name, hash: meta.hash, addedAt: meta.addedAt, size: meta.size, ext: meta.ext,
        paragraphs: meta.paragraphCount, lang: meta.lang, hasSummary: !!meta.summaryDone,
        annotations: anns.length, notes, exports: meta.exportCount || 0
      });
    }
  }
  out.sort((a, b) => b.addedAt - a.addedAt);
  return out;
}

async function handleUpload(req, res, url) {
  const force = url.searchParams.get('force') === '1';
  const nameEnc = req.headers['x-pl-name'] || '未命名.txt';
  let name = '未命名.txt';
  try { name = decodeURIComponent(nameEnc); } catch (e) {}
  const buf = await readBody(req);
  if (!buf.length) return json(res, 400, { error: '空文件' });
  const hash = sha256(buf);
  const idx = await loadIndex();
  if (idx[hash] && idx[hash].length && !force) {
    return json(res, 200, { duplicate: true, existing: idx[hash] });
  }
  const id = uid();
  const ext = path.extname(name) || '.txt';
  await fsp.mkdir(sub('library'), { recursive: true });
  await fsp.writeFile(sub('library', id + ext), buf);
  const extracted = await extractParagraphs(buf, ext, name);
  const paras = extracted.paras;
  await fsp.mkdir(await fileDir(id), { recursive: true });
  const meta = {
    id, name, hash, ext, size: buf.length, addedAt: now(),
    paragraphCount: paras.length, lang: isChinese(paras.map(p => p.text).join(' ').slice(0, 4000)) ? 'zh' : 'en',
    summaryDone: false, exportCount: 0, hasLayout: !!extracted.layout,
    layoutVersion: extracted.layout ? (extracted.layout.version || 2) : 0
  };
  await writeJSONFile(path.join(await fileDir(id), 'meta.json'), meta);
  await writeJSONFile(path.join(await fileDir(id), 'paragraphs.json'), paras);
  await writeJSONFile(path.join(await fileDir(id), 'annotations.json'), []);
  if (extracted.layout) await writeJSONFile(path.join(await fileDir(id), 'layout.json'), extracted.layout);
  idx[hash] = idx[hash] || []; idx[hash].push(id);
  await saveIndex(idx);
  json(res, 200, { duplicate: false, id, meta });
}

async function handleDelete(req, res, id) {
  const dir = await fileDir(id);
  const meta = await readJSONFile(path.join(dir, 'meta.json'), null);
  await fsp.rm(dir, { recursive: true, force: true });
  if (meta) {
    const idx = await loadIndex();
    if (idx[meta.hash]) { idx[meta.hash] = idx[meta.hash].filter(x => x !== id); if (!idx[meta.hash].length) delete idx[meta.hash]; await saveIndex(idx); }
    try { await fsp.rm(sub('library', meta.id + (meta.ext || '')), { force: true }); } catch (e) {}
  }
  json(res, 200, { ok: true });
}

/* ---------------- 重新解析版面（旧版导入升级：修复分栏/图表/公式结构） ---------------- */
function findQuoteRange(text, quote) {
  const q = String(quote || '').trim();
  if (!q || !text) return null;
  const direct = text.indexOf(q);
  if (direct >= 0) return [direct, direct + q.length];
  const map = []; let norm = '';
  for (let k = 0; k < text.length; k++) {
    if (/\s/.test(text[k])) continue;
    norm += text[k].toLowerCase();
    map.push(k);
  }
  const nq = q.replace(/\s+/g, '').toLowerCase();
  if (!nq) return null;
  const j = norm.indexOf(nq);
  if (j < 0) return null;
  return [map[j], map[j + nq.length - 1] + 1];
}
async function handleReanalyze(req, res, id) {
  const dir = await fileDir(id);
  const meta = await readJSONFile(path.join(dir, 'meta.json'), null);
  if (!meta) return json(res, 404, { error: '文件不存在' });
  if ((meta.ext || '').toLowerCase() !== '.pdf') return json(res, 400, { error: '仅 PDF 需要重新解析版面' });
  const raw = await fsp.readFile(sub('library', meta.id + (meta.ext || '.pdf')));
  const { analyzePdf } = require('./pdflayout.js');
  const r = await analyzePdf(raw);
  const oldParas = await readJSONFile(path.join(dir, 'paragraphs.json'), []);
  const oldByText = new Map();
  for (const p of oldParas) if (p.zh && p.text) oldByText.set(p.text, p.zh);

  const isZhDoc = isChinese(r.paragraphs.map(p => p.text).join(' ').slice(0, 4000));
  const paras = r.paragraphs.map(p => {
    const keep = (isZhDoc || p.type === 'meta' || p.type === 'formula' || p.type === 'figure')
      ? p.text
      : (oldByText.get(p.text) || null);
    return { ...p, zh: keep, translatedAt: keep ? now() : null };
  });

  /* 标注迁移：按原文片段在新段落中重新定位，无法定位的丢弃 */
  const anns = await getAnnotations(id);
  const enIndex = paras.filter(p => p.type !== 'figure' && p.type !== 'formula' && p.text);
  const kept = [];
  let lost = 0;
  for (const a of anns) {
    if (!a.quote) { kept.push(a); continue; }
    /* 原版视图的行级标注：行索引已随版面重建失效，尽量转成段落级标注，无法定位则丢弃 */
    if (a.view === 'original') {
      let hit = null, range = null;
      for (const p of enIndex) {
        const rg = findQuoteRange(p.text, a.quote);
        if (rg) { hit = p; range = rg; break; }
      }
      if (!hit) { lost++; continue; }
      kept.push({ ...a, view: undefined, segs: undefined, para: hit.i, side: 'en', start: range[0], end: range[1] });
      continue;
    }
    const pool = a.side === 'zh' ? enIndex.filter(p => p.zh) : enIndex;
    let hit = null, range = null;
    for (const p of pool) {
      const rg = findQuoteRange(a.side === 'zh' ? p.zh : p.text, a.quote);
      if (rg) { hit = p; range = rg; break; }
    }
    if (!hit) { lost++; continue; }
    /* 重叠去重：仅丢弃没有任何批注/转入记录的重复标注 */
    const others = kept.filter(x => x.para === hit.i && x.side === a.side && !(x.start >= range[1] || x.end <= range[0]));
    if (others.length && !a.note && !a.transferredAt) { lost++; continue; }
    kept.push({ ...a, para: hit.i, start: range[0], end: range[1], staleFixed: true });
  }
  await writeJSONFile(path.join(dir, 'paragraphs.json'), paras);
  await writeJSONFile(path.join(dir, 'layout.json'), r.layout);
  await saveAnnotations(id, kept);
  meta.paragraphCount = paras.length;
  meta.hasLayout = true;
  meta.layoutVersion = r.layout.version;
  meta.lang = isZhDoc ? 'zh' : 'en';
  await writeJSONFile(path.join(dir, 'meta.json'), meta);
  return json(res, 200, { ok: true, paragraphs: paras.length, annotations: { kept: kept.length, lost } });
}

/* ---------------- 标注（划线+批注+转入笔记 统一实体） ---------------- */
async function getAnnotations(id) { return readJSONFile(path.join(await fileDir(id), 'annotations.json'), []); }
async function saveAnnotations(id, list) { await writeJSONFile(path.join(await fileDir(id), 'annotations.json'), list); }

/* ---------------- 翻译（结构化分块，SSE 进度） ---------------- */
const TYPE_LABEL = {
  heading: '章节标题', para: '正文段落', list: '列表条目',
  caption: '图表标题', table: '表格（TSV：制表符分列、换行分行）'
};

const TRANSLATE_SYS = `你是学术论文翻译引擎，负责把英文文献的文本块译成规范简体中文，并严格保持每个块的结构属性。

用户会给出一个 JSON 数组，元素形如 {"id": 12, "type": "para", "text": "...", "ctx": "上一块原文末尾"}。请逐块翻译，输出**长度相同、顺序一致**的 JSON 数组：

**第一步：先理解，再动笔。** 通读本批全部文本块与 ctx，弄清这一段在讲什么、处在文章的什么位置（定义？推导？结论？），据此决定每一块该怎么译、译文从哪里断句。目标是让相邻块读起来像同一个人连续写下的中文，而不是逐句对译的拼盘。

**第二步：按语义断句。** 
- 一个块内部要译成连贯的一段，句与句之间自然过渡，不得按英文语序硬切。
- 若某块明显是被版面或 OCR 截断的碎片（半个句子、孤立数字、单独符号、被上下标拆开的公式片段），先结合 ctx 与上下文补全语义，再译成完整通顺的中文句子；禁止输出"x""卡""10-6。""TRb"这类孤立碎片。
- 相邻块之间不得重复同一句，也不得跳跃；上块以半句结尾时，本块要顺着接上。
[{"id": 12, "zh": "……"}]

按块类型处理：
- heading：章节标题。保留原有编号前缀（如 "2.1"、"3."），译名简洁，结尾不加句号。
- para：正文段落。整段一次译出，译文内部不换行、不拆句编号，前后句自然衔接。
- list：列表/关键词条目。只译条目内容，不要添加项目符号。
- caption：图表标题。保留 "图 1"、"表 2" 这样的编号形式。
- table：表格。text 是 TSV，用制表符分列、换行分行。译文必须保持完全相同的行数与每行列数，逐格翻译；纯数字、符号、单位单元格原样保留；不得增删制表符或换行。

通用规则：
1. ctx 是紧邻上一块的原文末尾，仅用于理解上下文，不要翻译它。若文本以数字、小写字母或连接词开头（如 "2. As presented in Table 1…"、"and the…"），说明它是上一块被分栏/分页截断的续段：请顺势衔接译出，不要把开头的数字当作序号。
2. 除专有名词（人名、地名、机构名、缩写）外，不得残留英文单词或英文短语。
3. 数学符号、变量、数字、单位、希腊字母、化学式按原字符照抄并自然嵌入句子，不要改写形式。
4. 严禁输出 LaTeX：不得出现 \\( \\) \\[ \\] $ \\mathrm \\times 之类记号。
5. 原文存在 OCR 噪声（10 印成 ro、β 印成 fl、断词连字符）时按语义理解后正常译出，不要保留断词。
6. 术语用标准中文译法，首次出现可括注英文。
7. 只输出 JSON 数组本身，不要 markdown 代码块，不要任何解释。`;

/* 清洗模型输出中残留的 LaTeX/公式标记，转为纯文本符号 */
function cleanZh(s, keepLayout) {
  const one = x => {
    let t = String(x || '');
    t = t.replace(/\\(mathrm|text|mathbf|mathit|textit|operatorname)\s*\{([^{}]*)\}/g, '$2');
    t = t.replace(/_\{([^{}]*)\}/g, '_$1');
    t = t.replace(/\^\{([^{}]*)\}/g, '^$1');
    t = t.replace(/\\[(\[]/g, '').replace(/\\[)\]]/g, '');
    t = t.replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\approx/g, '≈')
      .replace(/\\pm/g, '±').replace(/\\sim/g, '～').replace(/\\%/g, '%').replace(/\\leq/g, '≤').replace(/\\geq/g, '≥');
    t = t.replace(/\\[A-Za-z]+\s*/g, '');
    return t.replace(/[ \t]+/g, ' ').trim();
  };
  if (keepLayout) return String(s || '').split('\n').map(l => l.split('\t').map(one).join('\t')).join('\n').trim();
  return one(String(s || '').replace(/\s+/g, ' '));
}
function parseBlockJson(raw) {
  let t = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try { const v = JSON.parse(t.slice(a, b + 1)); if (Array.isArray(v)) return v; } catch (e) {}
  }
  return null;
}
function tableShape(t) {
  const lines = String(t || '').split('\n');
  return lines.length + 'x' + (lines[0] || '').split('\t').length;
}
/* 校验并规整单块译文：保留列表换行、表格 TSV 结构、标题编号 */
function finalizeZh(p, raw) {
  const keepLayout = p.type === 'table';
  let zh = cleanZh(raw, keepLayout);
  if (!zh) return null;
  if (p.type === 'heading') {
    zh = zh.replace(/[。.]+$/, '');
    if (p.num && !new RegExp('^' + p.num.replace(/\./g, '\\.') + '(\\s|\\.)').test(zh)) zh = p.num + ' ' + zh;
  }
  if (p.type === 'caption' && p.text) {
    const m = p.text.match(/^(fig(?:ure)?\.?|table|tab\.)\s*(\d+)/i);
    if (m) {
      const label = (m[1].toLowerCase().startsWith('tab') ? '表 ' : '图 ') + m[2] + ' ';
      const body = zh.replace(/^[图表]\s*\d*[.:：、\-\s]*/i, '').replace(/^(fig(?:ure)?\.?|table|tab\.)?\s*\d+[.:]?\s*/i, '');
      zh = label + body;
    }
  }
  return zh;
}
async function translateBatch(title, blocks, signal, prevOf) {
  const out = new Map();
  const payload = blocks.map(b => {
    const ctx = prevOf && prevOf.get(b.i);
    let text = b.text;
    /* 跨栏截断的「图 2 所示…」：上一块以 Fig./Table 结尾、本块以数字开头时补齐词头，避免译成孤立的编号 */
    if (ctx) {
      const tail = String(ctx).match(/(Fig\.?|Figure|Table|Eq\.?|Equation|Section|Sec\.?)\s*$/i);
      if (tail && /^\d{1,3}[a-z]?\.?\s/.test(text)) text = tail[1] + ' ' + text;
    }
    const o = { id: b.i, type: b.type, text };
    if (ctx) o.ctx = ctx;
    return o;
  });
  const user = `文献标题：${title || ''}\n\n待翻译文本块（共 ${payload.length} 个）：\n` + JSON.stringify(payload);
  const raw = await llmChat('process', {
    messages: [{ role: 'system', content: TRANSLATE_SYS }, { role: 'user', content: user }],
    temperature: 0.25, signal
  });
  const arr = parseBlockJson(raw);
  if (!arr) throw new Error('模型未返回可解析的 JSON 结果');
  for (const it of arr) {
    const id = Number(it.id != null ? it.id : it.index);
    const zh = it.zh != null ? it.zh : (it.translation != null ? it.translation : it.text);
    if (Number.isFinite(id) && typeof zh === 'string' && zh.trim()) out.set(id, zh);
  }
  return out;
}
async function translateSingle(title, p, signal) {
  const raw = await llmChat('process', {
    messages: [
      { role: 'system', content: TRANSLATE_SYS },
      { role: 'user', content: `文献标题：${title || ''}\n\n待翻译文本块（共 1 个）：\n` + JSON.stringify([{ id: p.i, type: p.type, text: p.text }]) }
    ],
    temperature: 0.25, signal
  });
  const arr = parseBlockJson(raw);
  if (arr && arr[0]) {
    const zh = arr[0].zh != null ? arr[0].zh : arr[0].text;
    if (typeof zh === 'string' && zh.trim()) return zh;
  }
  /* 兼容直接返回纯文本译文的模型 */
  const plain = String(raw || '').replace(/^\s*```\w*\s*|\s*```\s*$/g, '').trim();
  if (plain && !/^[[{]/.test(plain)) return plain;
  throw new Error('模型返回空译文（建议把文献处理模型设为 deepseek-chat）');
}
async function handleTranslate(req, res, id, body) {
  sseInit(res);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  try {
    const dir = await fileDir(id);
    const meta = await readJSONFile(path.join(dir, 'meta.json'), {});
    const pFile = path.join(dir, 'paragraphs.json');
    const paras = await readJSONFile(pFile, []);
    const TRANSLATABLE = ['heading', 'para', 'list', 'caption'];
    const need = p => TRANSLATABLE.includes(p.type) && !p.zh && String(p.text || '').trim();
    let targets = paras.filter(need);
    if (body && Array.isArray(body.indexes) && body.indexes.length) {
      targets = paras.filter(p => body.indexes.includes(p.i) && need(p));
    }
    if (!targets.length) { sseSend(res, 'done', { count: 0, failed: 0, firstError: '' }); return res.end(); }

    const total = targets.length;
    let done = 0, failed = 0, firstError = '';
    const results = new Map();
    /* 跨栏/跨页续段：把上一块原文末尾作为上下文，避免编号被误译 */
    const prevOf = new Map();
    let prevTail = '';
    for (const p of paras) {
      if (!need(p)) continue;
      if (prevTail) prevOf.set(p.i, prevTail);
      prevTail = String(p.text || '').slice(-200);
    }
    const BATCH = 6, CONC = 3;
    const batches = [];
    for (let k = 0; k < targets.length; k += BATCH) batches.push(targets.slice(k, k + BATCH));

    let cursor = 0;
    async function worker() {
      while (cursor < batches.length) {
        const group = batches[cursor++];
        let got = new Map();
        let err = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { got = await translateBatch(meta.name, group, ctrl.signal, prevOf); err = null; break; }
          catch (e) { err = e; if (ctrl.signal.aborted) break; }
        }
        for (const p of group) {
          let zh = got.get(p.i);
          if (!zh) {
            try { zh = await translateSingle(meta.name, p, ctrl.signal); }
            catch (e) { err = err || e; }
          }
          const fin = zh ? finalizeZh(p, zh) : null;
          if (fin) {
            /* 表格结构校验：行列数与原文不一致时标记，前端回退为区域截图 */
            const bad = p.type === 'table' && tableShape(fin) !== tableShape(p.text);
            results.set(p.i, { zh: fin, translatedAt: now(), zhOk: !bad });
          } else {
            failed++; if (!firstError && err) firstError = err.message;
            results.set(p.i, { error: (err && err.message) || '空译文' });
          }
          done++;
          const r = results.get(p.i);
          sseSend(res, 'progress', { done, total, index: p.i, type: p.type, failed, zh: r.zh || null });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, worker));
    for (const p of paras) {
      const r = results.get(p.i);
      if (r && r.zh) { p.zh = r.zh; p.translatedAt = r.translatedAt; p.zhOk = r.zhOk !== false; }
    }
    await writeJSONFile(pFile, paras);
    sseSend(res, 'done', { count: done, failed, firstError });
  } catch (e) {
    sseSend(res, 'error', { message: e.message });
  }
  res.end();
}

/* ---------------- 智能纪要（流式） ---------------- */
const SUMMARY_SYS = `你是顶尖的学术论文阅读助手。请基于用户提供的文献内容，输出一份结构清晰的中文智能纪要（Markdown 格式），包含以下小节：
# 文献智能纪要
## 一句话概括
## 背景与问题
## 研究方法
## 关键结果（可用要点列表）
## 结论与创新点
## 局限与展望
## 阅读建议（3 条以内，告诉读者应重点关注哪些部分）
要求：忠于原文、不编造；语言精炼；总长度控制在 600-1000 字。`;
async function handleSummary(req, res, id, body) {
  sseInit(res);
  try {
    const dir = await fileDir(id);
    const meta = await readJSONFile(path.join(dir, 'meta.json'), {});
    const paras = await readJSONFile(path.join(dir, 'paragraphs.json'), []);
    const text = paras.map(p => (p.type === 'heading' ? '# ' : '') + p.text).join('\n\n');
    const truncated = text.length > 26000 ? text.slice(0, 26000) + '\n\n[内容过长，已截断]' : text;
    let full = '';
    await llmChat('process', {
      messages: [{ role: 'system', content: SUMMARY_SYS }, { role: 'user', content: `文献标题：${meta.name || ''}\n\n${truncated}` }],
      stream: true,
      onDelta: (piece, acc) => { full = acc; sseSend(res, 'delta', { piece }); }
    });
    const summary = { text: full, generatedAt: now(), truncated: text.length > 26000 };
    await writeJSONFile(path.join(dir, 'summary.json'), summary);
    meta.summaryDone = true;
    await writeJSONFile(path.join(dir, 'meta.json'), meta);
    sseSend(res, 'done', { generatedAt: summary.generatedAt });
  } catch (e) {
    sseSend(res, 'error', { message: e.message });
  }
  res.end();
}

/* ---------------- AI 问答（流式 + 思考强度 + 文档上下文） ---------------- */
async function handleChat(req, res, body) {
  sseInit(res);
  try {
    const { messages = [], intensity = 'standard', useDoc = false, fileId = '' } = body;
    const cfg = (await loadConfig());
    const chatCfg = cfg.chat;
    let context = '';
    if (useDoc && fileId) {
      const dir = await fileDir(fileId);
      const meta = await readJSONFile(path.join(dir, 'meta.json'), {});
      const sum = await readJSONFile(path.join(dir, 'summary.json'), null);
      const notes = (await getAnnotations(fileId)).filter(a => a.note);
      const paras = await readJSONFile(path.join(dir, 'paragraphs.json'), []);
      context += `当前阅读文献：《${meta.name || '未知'}》\n`;
      if (sum && sum.text) context += `\n【智能纪要】\n${sum.text.slice(0, 4000)}\n`;
      if (notes.length) context += `\n【读者已标注/批注的要点】\n${notes.map(a => `- ${String(a.quote || '').slice(0, 120)}${a.note ? '（批注：' + String(a.note).slice(0, 100) + '）' : ''}`).join('\n').slice(0, 2000)}\n`;
      if (paras.length && !sum) context += `\n【文献节选】\n${paras.map(p => p.text).join(' ').slice(0, 6000)}\n`;
    }
    const sysBase = '你是 PaperLens 论文研读台的 AI 研究助理，擅长科研文献解读与学术问答。用简体中文回答；公式用文字或简单符号表达；回答结构清晰、准确、不编造。若用户的问题与所附文献相关，请紧扣文献内容作答。';
    if (intensity === 'fast') {
      messages.unshift({ role: 'system', content: sysBase + '\n（快速模式：请尽量简明扼要，直接给结论与要点。）' });
    } else {
      messages.unshift({ role: 'system', content: sysBase });
    }
    if (context) messages.unshift({ role: 'system', content: '以下是用户当前正在阅读的文献信息，供你参考：\n' + context });
    const model = intensity === 'deep' ? (chatCfg.reasoningModel || 'deepseek-reasoner') : (chatCfg.model || 'deepseek-chat');
    sseSend(res, 'meta', { model, intensity });
    await llmChat('chat', {
      messages, stream: true, modelOverride: model,
      onDelta: piece => sseSend(res, 'delta', { piece })
    });
    sseSend(res, 'done', {});
  } catch (e) {
    sseSend(res, 'error', { message: e.message });
  }
  res.end();
}

/* ---------------- 导出 PDF（先组装打印版 HTML） ---------------- */
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const HL_STYLE = {
  yellow: '#fff1a8', green: '#d1f5d3', blue: '#cfe5ff', red: '#ffd9d4', purple: '#ead9ff'
};
function tsvToGrid(t) {
  return String(t || '').split('\n').map(l => l.split('\t'));
}
async function cropDataUrl(id, region) {
  if (!region || !region.crop) return '';
  try {
    const buf = await fsp.readFile(path.join(await fileDir(id), 'crops', region.crop));
    return 'data:image/' + (/\.png$/i.test(region.crop) ? 'png' : 'jpeg') + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; }
}
async function buildExportHtml(id) {
  const dir = await fileDir(id);
  const meta = await readJSONFile(path.join(dir, 'meta.json'), {});
  const paras = await readJSONFile(path.join(dir, 'paragraphs.json'), []);
  const layout = await readJSONFile(path.join(dir, 'layout.json'), null);
  const anns = (await getAnnotations(id)).slice().sort((a, b) => a.para - b.para || a.start - b.start);
  const notes = anns.filter(a => a.transferredAt);
  const sum = await readJSONFile(path.join(dir, 'summary.json'), null);

  const regionById = {};
  for (const pg of (layout && layout.pages) || []) for (const r of (pg.regions || [])) regionById[r.id] = r;

  const byKey = {};
  for (const a of anns) (byKey[a.para + '|' + a.side] = byKey[a.para + '|' + a.side] || []).push(a);
  function renderSide(p, side) {
    const text = side === 'en' ? p.text : (p.zh || '');
    if (!text) return '';
    const list = (byKey[p.i + '|' + side] || []).slice().sort((a, b) => a.start - b.start || b.end - a.end);
    let out = '', pos = 0;
    for (const a of list) {
      if (a.start < pos || a.start > text.length || a.end > text.length) continue;
      out += esc(text.slice(pos, a.start));
      const frag = esc(text.slice(a.start, a.end));
      out += `<span class="hl" style="background:${HL_STYLE[a.color] || HL_STYLE.yellow}">${frag}</span>`;
      if (a.note) out += `<sup class="ann-mark">批</sup>`;
      pos = a.end;
    }
    out += esc(text.slice(pos));
    return out;
  }
  const bodyParts = [];
  for (const p of paras) {
    if (p.type === 'meta') continue;
    const region = p.region ? regionById[p.region] : null;
    /* 图 / 表 / 公式一律以原版面截图导出 */
    if (p.type === 'figure' || p.type === 'table' || (p.type === 'formula' && region)) {
      const src = await cropDataUrl(id, region);
      if (src) {
        bodyParts.push(`<figure class="exp-fig"><img src="${src}" style="max-width:${p.type === 'formula' ? 88 : 100}%"></figure>`);
        continue;
      }
      if (p.type !== 'formula') continue;
    }
    const en = renderSide(p, 'en');
    const zh = p.zh != null && p.zh !== p.text ? renderSide(p, 'zh') : '';
    if (!en && !zh) continue;
    const cls = p.type === 'heading' ? 'exp-h' + (p.level === 2 ? ' exp-h2' : '') : (p.type === 'caption' ? 'exp-cap' : 'exp-p');
    let blk = '<div class="exp-block">';
    if (p.type === 'list' && en) blk += `<div class="exp-li"><span class="b">·</span><span>${en.replace(/^·\s*/, '')}</span></div>`;
    else if (en) blk += `<div class="${cls} exp-en">${en}</div>`;
    if (zh) blk += `<div class="exp-zh${p.type === 'heading' ? ' exp-zh-h' : ''}${p.type === 'caption' ? ' exp-cap' : ''}${p.type === 'list' ? ' exp-li-zh' : ''}">${zh}</div>`;
    blk += '</div>';
    bodyParts.push(blk);
  }
  const notesHtml = notes.length ? `
  <section class="exp-section"><h1>实时笔记（事实笔记）</h1>
  ${notes.map(n => `<div class="exp-note" style="border-left:4px solid ${HL_STYLE[n.color] || HL_STYLE.yellow}">
      <div class="q">${esc(n.quote || '')}</div>
      ${n.counterpart ? `<div class="q2">${esc(n.counterpart)}</div>` : ''}
      ${n.note ? `<div class="nn"><b>想法：</b>${esc(n.note)}</div>` : ''}
      <div class="t">转入时间：${fmtTime(n.transferredAt)}　批注完成：${n.noteUpdatedAt ? fmtTime(n.noteUpdatedAt) : '—'}</div>
    </div>`).join('')}
  </section>` : '';
  const sumHtml = sum && sum.text ? `
  <section class="exp-section"><h1>智能纪要</h1>
  <div class="exp-md">${esc(sum.text)}</div>
  <div class="t">生成时间：${fmtTime(sum.generatedAt)}</div></section>` : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(meta.name || '文献')} · PaperLens 导出</title>
<style>
  body{font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#1f2937;line-height:1.75;margin:40px 46px;font-size:11.5pt}
  h1{font-size:18pt;border-bottom:2px solid #2563eb;padding-bottom:8px;color:#1d4ed8}
  .cover{margin-bottom:26px}.cover h1{margin:0 0 10px}
  .cover .meta{color:#6b7280;font-size:10pt}
  .exp-block{margin:10px 0}
  .exp-en{font-family:Georgia,"Times New Roman",serif}
  .exp-zh{color:#1f2937;margin-top:3px}
  .exp-h{font-weight:bold;font-size:13pt;margin-top:20px;color:#111827;border-left:3px solid #2563eb;padding-left:8px}
  .exp-h2{font-size:12pt}
  .exp-zh-h{font-size:13pt;font-weight:bold;margin-top:2px}
  .exp-cap,.exp-zh.exp-cap{font-size:9.5pt;color:#6b7280}
  .exp-li{display:flex;gap:6px;font-family:Georgia,"Times New Roman",serif}
  .exp-li .b{color:#2563eb}
  .exp-fig{margin:12px 0;text-align:center;page-break-inside:avoid}
  .exp-fig img{max-height:520px;border:1px solid #e5e7eb;border-radius:4px}
  .exp-tb{border-collapse:collapse;margin:10px 0;width:100%;font-size:10pt;page-break-inside:avoid}
  .exp-tb td{border:1px solid #9ca3af;padding:4px 6px;vertical-align:middle}
  .exp-src{font-size:8.5pt;color:#9ca3af;margin:2px 0 10px}
  .hl{padding:0 1px;border-radius:2px}
  .ann-mark{color:#2563eb;font-size:8pt;font-weight:bold}
  .exp-section{margin-top:34px;page-break-before:always}
  .exp-section h1{font-size:15pt}
  .exp-note{margin:12px 0;padding:10px 14px;background:#f8fafc;border-radius:6px}
  .exp-note .q{font-weight:600}
  .exp-note .q2{color:#6b7280;font-style:italic;margin-top:2px}
  .exp-note .nn{margin-top:6px}
  .exp-note .t{color:#9ca3af;font-size:9pt;margin-top:6px}
  .exp-md{white-space:pre-wrap;background:#f8fafc;padding:16px 18px;border-radius:8px}
  @page{margin:18mm 16mm}
</style></head><body>
<div class="cover"><h1>${esc(meta.name || '文献')}</h1>
<div class="meta">PaperLens 论文研读台 · 导出时间：${fmtTime(now())} · 段落 ${paras.filter(p => p.type !== 'meta').length} · 标注 ${anns.length} · 笔记 ${notes.length}</div></div>
${bodyParts.join('\n')}
${notesHtml}
${sumHtml}
<script>
  if (new URLSearchParams(location.search).get('print') === '1') {
    setTimeout(() => window.print(), 400);
  }
</script>
</body></html>`;
}

async function loadExportHistory() { return readJSONFile(sub('exports.json'), []); }
async function saveExportHistory(h) { await writeJSONFile(sub('exports.json'), h); }
async function loadChats() { return readJSONFile(sub('chats.json'), []); }
async function saveChats(c) { await writeJSONFile(sub('chats.json'), c); }

async function handleExport(req, res, id, body) {
  const force = body && body.force;
  const dir = await fileDir(id);
  const meta = await readJSONFile(path.join(dir, 'meta.json'), null);
  if (!meta) return json(res, 404, { error: '文件不存在' });
  const history = await loadExportHistory();
  const dup = history.find(h => h.hash === meta.hash);
  if (dup && !force) {
    return json(res, 200, { duplicate: true, existing: dup });
  }
  await ensureDirs();
  const ts = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
  const baseName = (meta.name || 'export').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  const htmlName = `preview-${id}-${stamp}.html`;
  const htmlPath = sub('exports', htmlName);
  await fsp.writeFile(htmlPath, await buildExportHtml(id), 'utf8');
  const pdfName = `${baseName}_标注批注纪要_${stamp}.pdf`;
  const pdfPath = sub('exports', pdfName);
  meta.exportCount = (meta.exportCount || 0) + 1;
  await writeJSONFile(path.join(dir, 'meta.json'), meta);
  const record = { id: uid(), fileId: id, hash: meta.hash, name: meta.name, time: now(), htmlName, pdfName, pdfDone: false };
  history.unshift(record); await saveExportHistory(history);
  json(res, 200, { duplicate: false, htmlPath, htmlName, pdfPath, pdfName, record });
}

/* ---------------- 主题系统 ---------------- */
async function listThemes() {
  await ensureDirs();
  const ids = ['blue-business', 'deep-night', 'paper-warm'];
  const out = [];
  for (const id of ids) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(PROJECT_ROOT, 'themes', id + '.json'), 'utf8'))); } catch (e) {}
  }
  let userDir = sub('themes');
  let files = [];
  try { files = await fsp.readdir(userDir); } catch (e) {}
  for (const f of files) {
    if (f.endsWith('.json')) {
      try { const t = JSON.parse(await fsp.readFile(path.join(userDir, f), 'utf8')); if (t && t.id) out.push(t); } catch (e) {}
    }
  }
  return out;
}

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2'
};
function serveFile(res, filePath, fallback404) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      if (fallback404) return serveFile(res, fallback404);
      res.writeHead(404); return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */
async function route(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const m = req.method;

  /* --- 静态 --- */
  if (m === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(PROJECT_ROOT, 'public', 'index.html'));
  if (m === 'GET' && p.startsWith('/static/')) return serveFile(res, path.join(PROJECT_ROOT, 'public', p.slice('/static/'.length)));
  if (m === 'GET' && p.startsWith('/vendor/pdfjs/')) return serveFile(res, path.join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', p.slice('/vendor/pdfjs/'.length)));
  if (m === 'GET' && p.startsWith('/media/theme/')) { await ensureDirs(); return serveFile(res, sub('themes', 'uploads', p.slice('/media/theme/'.length))); }
  if (m === 'GET' && p.startsWith('/media/exports/')) { await ensureDirs(); return serveFile(res, sub('exports', decodeURIComponent(p.slice('/media/exports/'.length)))); }
  if (m === 'GET' && p.startsWith('/media/crops/')) {
    const rest = p.slice('/media/crops/'.length).split('/');
    if (rest.length >= 2) return serveFile(res, path.join(dataRoot(), 'files', rest[0], 'crops', decodeURIComponent(rest[1])));
  }

  try {
    /* --- 引导配置 --- */
    if (m === 'GET' && p === '/api/bootstrap') {
      await ensureDirs();
      const cfg = await loadConfig();
      json(res, 200, { config: maskConfig(cfg), themes: await listThemes(), files: await listFiles(), desktop: false, version: '1.0.0', dataRoot: dataRoot() });
      return;
    }
    if (m === 'POST' && p === '/api/config') {
      const body = await readJSON(req);
      const cfg = await loadConfig();
      for (const g of ['process', 'chat']) {
        if (body[g]) {
          for (const k of ['baseUrl', 'model', 'reasoningModel', 'intensity', 'temperature']) {
            if (body[g][k] !== undefined) cfg[g][k] = body[g][k];
          }
          if (body[g].apiKey && body[g].apiKey !== 'KEEP') cfg[g].apiKey = body[g].apiKey.trim();
        }
      }
      if (body.theme) { cfg.theme = deepMerge(cfg.theme, body.theme); }
      if (body.layout) cfg.layout = deepMerge(cfg.layout, body.layout);
      if (body.fontScale !== undefined) cfg.fontScale = body.fontScale;
      if (body.lastFileId !== undefined) cfg.lastFileId = body.lastFileId;
      await saveConfig(cfg);
      return json(res, 200, { ok: true, config: maskConfig(cfg) });
    }
    if (m === 'POST' && p === '/api/config/test') {
      const { group } = await readJSON(req);
      try {
        const out = await llmChat(group, { messages: [{ role: 'user', content: '回复"连接成功"四个字' }], temperature: 0 });
        return json(res, 200, { ok: true, reply: String(out).trim().slice(0, 40) });
      } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }

    /* --- 文件 --- */
    if (m === 'GET' && p === '/api/files') return json(res, 200, await listFiles());
    if (m === 'POST' && p === '/api/files/upload') return await handleUpload(req, res, u);
    {
      const fm = p.match(/^\/api\/files\/([\w-]+)(\/.*)?$/);
      if (fm) {
        const id = fm[1], subp = fm[2] || '';
        if (m === 'DELETE' && !subp) return await handleDelete(req, res, id);
        const dir = await fileDir(id);
        if (m === 'GET' && subp === '/meta') return json(res, 200, await readJSONFile(path.join(dir, 'meta.json'), {}));
        if (m === 'GET' && subp === '/paragraphs') return json(res, 200, await readJSONFile(path.join(dir, 'paragraphs.json'), []));
        if (m === 'GET' && subp === '/layout') return json(res, 200, await readJSONFile(path.join(dir, 'layout.json'), null));
        if (m === 'POST' && subp === '/crops') {
          /* 前端按版面区域裁切出的图/表/公式图片：落盘保存，并在 layout 中登记文件名 */
          const body = await readJSON(req);
          const list = Array.isArray(body.crops) ? body.crops : [];
          const cdir = path.join(dir, 'crops');
          await fsp.mkdir(cdir, { recursive: true });
          const pFile = path.join(dir, 'layout.json');
          const layout = await readJSONFile(pFile, null);
          if (!layout || !layout.pages) return json(res, 400, { error: '无版面数据' });
          const saved = {};
          for (const c of list) {
            const mm = String(c && c.dataUrl || '').match(/^data:image\/(png|jpeg|jpg);base64,([\s\S]+)$/);
            if (!mm || !c.id) continue;
            const ext = mm[1] === 'png' ? '.png' : '.jpg';
            const name = String(c.id).replace(/[^\w.-]/g, '') + ext;
            await fsp.writeFile(path.join(cdir, name), Buffer.from(mm[2], 'base64'));
            saved[c.id] = name;
          }
          for (const pg of layout.pages) for (const r of (pg.regions || [])) if (saved[r.id]) r.crop = saved[r.id];
          await writeJSONFile(pFile, layout);
          /* 清理不再被引用的旧裁切文件，避免版面重建后残留错图 */
          try {
            const used = new Set();
            for (const pg of layout.pages) for (const r of (pg.regions || [])) if (r.crop) used.add(r.crop);
            for (const f of await fsp.readdir(cdir)) if (!used.has(f)) await fsp.unlink(path.join(cdir, f)).catch(() => {});
          } catch (e) {}
          return json(res, 200, { ok: true, saved });
        }
        if (m === 'POST' && subp === '/reanalyze') return await handleReanalyze(req, res, id);
        if (m === 'GET' && subp === '/original') {
          const mt = await readJSONFile(path.join(dir, 'meta.json'), {});
          return serveFile(res, sub('library', mt.id + (mt.ext || '.pdf')));
        }
        if (m === 'GET' && subp === '/annotations') return json(res, 200, await getAnnotations(id));
        if (m === 'POST' && subp === '/annotations') {
          const list = await readJSON(req);
          if (!Array.isArray(list)) return json(res, 400, { error: '格式错误' });
          await saveAnnotations(id, list);
          return json(res, 200, { ok: true });
        }
        if (m === 'POST' && subp === '/summary') return await handleSummary(req, res, id);
        if (m === 'POST' && subp === '/translate') { const body = await readJSON(req); return await handleTranslate(req, res, id, body); }
        if (m === 'POST' && subp === '/export') { const body = await readJSON(req); return await handleExport(req, res, id, body); }
        if (m === 'GET' && subp === '/summary') { const s = await readJSONFile(path.join(dir, 'summary.json'), null); return json(res, 200, s || {}); }
      }
    }

    /* --- 问答 --- */
    if (m === 'POST' && p === '/api/chat') { const body = await readJSON(req); return await handleChat(req, res, body); }

    /* --- 导出历史 --- */
    if (m === 'GET' && p === '/api/exports') return json(res, 200, await loadExportHistory());

    /* --- 问答历史 --- */
    if (m === 'GET' && p === '/api/chats') return json(res, 200, await loadChats());
    if (m === 'POST' && p === '/api/chats/save') {
      const s = await readJSON(req);
      if (!s || !s.id || !Array.isArray(s.messages)) return json(res, 400, { error: '会话格式错误' });
      const chats = await loadChats();
      const idx = chats.findIndex(c => c.id === s.id);
      const rec = {
        id: String(s.id), title: String(s.title || '未命名会话').slice(0, 60),
        fileId: String(s.fileId || ''), fileName: String(s.fileName || '').slice(0, 80),
        messages: s.messages.slice(-200), saved: !!s.saved,
        createdAt: idx >= 0 ? chats[idx].createdAt : now(), updatedAt: now()
      };
      if (idx >= 0) chats[idx] = rec; else chats.unshift(rec);
      chats.sort((a, b) => b.updatedAt - a.updatedAt);
      /* 未保存会话自动滚动清理：最多保留 30 条 */
      const unsaved = chats.filter(c => !c.saved);
      if (unsaved.length > 30) {
        const kill = new Set(unsaved.slice(30).map(c => c.id));
        for (let i = chats.length - 1; i >= 0; i--) if (kill.has(chats[i].id)) chats.splice(i, 1);
      }
      await saveChats(chats);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/chats/toggle') {
      const { id, saved } = await readJSON(req);
      const chats = await loadChats();
      const c = chats.find(x => x.id === id);
      if (!c) return json(res, 404, { error: '会话不存在' });
      c.saved = !!saved;
      await saveChats(chats);
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE' && p === '/api/chats/unsaved') {
      let chats = await loadChats();
      chats = chats.filter(c => c.saved);
      await saveChats(chats);
      return json(res, 200, { ok: true, kept: chats.length });
    }
    {
      const cm = p.match(/^\/api\/chats\/([\w-]+)$/);
      if (m === 'DELETE' && cm) {
        let chats = await loadChats();
        chats = chats.filter(c => c.id !== cm[1]);
        await saveChats(chats);
        return json(res, 200, { ok: true });
      }
    }

    /* --- 主题 --- */
    if (m === 'GET' && p === '/api/themes') return json(res, 200, await listThemes());
    if (m === 'POST' && p === '/api/themes/import') {
      const t = await readJSON(req);
      if (!t || !t.name || !t.vars) return json(res, 400, { error: '主题包格式错误：需要 name 与 vars 字段' });
      t.id = 'user-' + uid().slice(0, 8);
      await ensureDirs();
      await fsp.writeFile(sub('themes', t.id + '.json'), JSON.stringify(t, null, 2));
      return json(res, 200, { ok: true, theme: t });
    }
    if (m === 'POST' && p === '/api/theme/bg') {
      const buf = await readBody(req, 20 * 1024 * 1024);
      const ext = (req.headers['x-pl-ext'] || '.png').replace(/[^.\w]/g, '') || '.png';
      await ensureDirs();
      await fsp.writeFile(sub('themes', 'uploads', 'bg' + ext), buf);
      const cfg = await loadConfig();
      cfg.theme.bgImage = '/media/theme/bg' + ext;
      await saveConfig(cfg);
      return json(res, 200, { ok: true, bgImage: cfg.theme.bgImage });
    }
    if (m === 'DELETE' && p === '/api/theme/bg') {
      const cfg = await loadConfig(); cfg.theme.bgImage = ''; await saveConfig(cfg);
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/dataroot') {
      const { dir } = await readJSON(req);
      if (!dir || !path.isAbsolute(dir)) return json(res, 400, { error: '请提供绝对路径' });
      RUNTIME.dataRoot = dir; saveRuntime();
      await ensureDirs();
      return json(res, 200, { ok: true, dataRoot: dataRoot() });
    }
    if (m === 'GET' && p === '/api/stats') {
      async function dirSize(d) {
        let s = 0;
        let items = []; try { items = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return 0; }
        for (const it of items) {
          const fp = path.join(d, it.name);
          if (it.isDirectory()) s += await dirSize(fp); else { try { s += (await fsp.stat(fp)).size; } catch (e) {} }
        }
        return s;
      }
      const bytes = await dirSize(dataRoot());
      return json(res, 200, { dataRoot: dataRoot(), bytes });
    }

    json(res, 404, { error: '接口不存在: ' + p });
  } catch (e) {
    console.error('[PaperLens] error:', p, e);
    json(res, 500, { error: e.message || '服务器内部错误' });
  }
}

/* ---------------- 启动 ---------------- */
const PORT_BASE = 8642;
async function findPort() {
  for (let p = PORT_BASE; p < PORT_BASE + 20; p++) {
    try {
      await new Promise((resolve, reject) => {
        const s = require('net').createServer();
        s.once('error', reject);
        s.once('listening', () => s.close(resolve));
        s.listen(p, '127.0.0.1');
      });
      return p;
    } catch (e) {}
  }
  throw new Error('8642-8661 端口均被占用');
}
async function startServer(opts = {}) {
  initPaths(opts);
  await ensureDirs();
  const port = await findPort();
  const server = http.createServer((req, res) => { route(req, res).catch(e => { try { json(res, 500, { error: e.message }); } catch (x) {} }); });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  if (!opts.silent) console.log(`[PaperLens] 服务已启动: http://127.0.0.1:${port}  数据目录: ${dataRoot()}`);
  return { port, server };
}
if (require.main === module) {
  startServer().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { startServer, dataRoot, PROJECT_ROOT, extractParagraphs, cleanZh };
