/* 诊断用：启动应用窗口，按脚本操作并截图（不参与正式运行） */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server/server.js');

const OUT = process.env.PL_SHOT_DIR || path.join(__dirname, '..', 'shots');
const FILE_NAME = process.env.PL_SHOT_FILE || '【测试】';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  const p = path.join(OUT, name + '.png');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(p, img.toPNG());
  console.log('[shot]', p);
}

app.whenReady().then(async () => {
  const { port } = await startServer({ silent: true });
  const win = new BrowserWindow({
    width: 1600, height: 980, show: true, backgroundColor: '#e9eef7',
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  const logs = [];
  win.webContents.on('console-message', (e, level, msg, line, src) => {
    logs.push(`[${level}] ${msg} (${(src || '').split('/').pop()}:${line})`);
    if (level >= 2) console.log('[renderer]', msg);
  });
  await win.loadURL(`http://127.0.0.1:${port}`);
  await sleep(2500);

  const ok = await win.webContents.executeJavaScript(`(async () => {
    const items = Array.from(document.querySelectorAll('.file-item'));
    const target = items.find(el => el.textContent.includes(${JSON.stringify(FILE_NAME)})) || items[0];
    if (!target) return 'no-file';
    target.click();
    return target.textContent.slice(0, 40);
  })()`);
  console.log('[open]', ok);
  await sleep(6000);
  const stat = await win.webContents.executeJavaScript(`JSON.stringify({
    blocks: document.querySelectorAll('#reader-content .blk').length,
    figs: document.querySelectorAll('#reader-content .fig-img').length,
    phs: document.querySelectorAll('#reader-content .media-ph').length,
    tables: document.querySelectorAll('#reader-content .doc-table').length,
    heads: document.querySelectorAll('#reader-content .t-heading').length,
    zh: document.querySelectorAll('#reader-content .t-zh').length,
    pending: document.querySelectorAll('#reader-content .t-zh.pending').length,
    meta: document.querySelector('#reader-meta').textContent
  })`);
  console.log('[text-view]', stat);
  await shot(win, '01-text-top');
  await win.webContents.executeJavaScript(`(()=>{const f=document.querySelector('#reader-content .t-figure'); if(f) f.scrollIntoView({block:'start'});})()`);
  await sleep(1500);
  await shot(win, '02-text-figure');
  await win.webContents.executeJavaScript(`(()=>{const f=document.querySelector('#reader-content .t-table'); if(f) f.scrollIntoView({block:'start'});})()`);
  await sleep(1200);
  await shot(win, '03-text-table');

  await win.webContents.executeJavaScript(`document.querySelector('#btn-parallel').click()`);
  await sleep(7000);
  const st2 = await win.webContents.executeJavaScript(`JSON.stringify({
    zhPages: document.querySelectorAll('#reader-content .zh-page').length,
    zhBlocks: document.querySelectorAll('#reader-content .zh-page .blk').length,
    zhImgs: document.querySelectorAll('#reader-content .zh-media').length,
    zhTb: document.querySelectorAll('#reader-content .zh-tb-wrap').length,
    origPages: document.querySelectorAll('#reader-content .pcol:first-child .opg').length
  })`);
  console.log('[parallel]', st2);
  await shot(win, '04-parallel-p1');
  await win.webContents.executeJavaScript(`(()=>{const p=document.querySelectorAll('#reader-content .pcol:first-child .opg'); if(p[2]) p[2].scrollIntoView({block:'start'});})()`);
  await sleep(1800);
  await shot(win, '05-parallel-p3');
  await win.webContents.executeJavaScript(`(()=>{const p=document.querySelectorAll('#reader-content .pcol:first-child .opg'); if(p[0]) p[0].scrollIntoView({block:'start'});})()`);
  await sleep(600);
  /* 放大一档，检查译文页文字与图表清晰度 */
  await win.webContents.executeJavaScript(`document.querySelector('#btn-zoom-in').click()`);
  await sleep(5000);
  await shot(win, '06-parallel-zoom');

  console.log('[logs]', logs.slice(-12).join(' || '));
  await sleep(500);
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
