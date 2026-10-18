'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer } = require('../server/server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const { port } = await startServer({ silent: true });
  const win = new BrowserWindow({ width: 1600, height: 980, show: true, webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), contextIsolation: true } });
  const errs = [];
  win.webContents.on('console-message', (e, l, m, ln, src) => { if (l >= 2) errs.push(m + ' @' + (src || '').split('/').pop() + ':' + ln); });
  win.webContents.on('render-process-gone', (e, d) => errs.push('CRASH ' + d.reason));
  await win.loadURL(`http://127.0.0.1:${port}`);
  await sleep(2500);
  const r1 = await win.webContents.executeJavaScript(`(async()=>{
    const items=Array.from(document.querySelectorAll('.file-item'));
    const out=[];
    for (const it of items.slice(0,3)) {
      it.click(); await new Promise(r=>setTimeout(r,3500));
      const cur=document.querySelector('#reader-meta').textContent;
      document.querySelector('#btn-parallel').click(); await new Promise(r=>setTimeout(r,4500));
      const par=document.querySelectorAll('#reader-content .zh-page').length;
      document.querySelector('#btn-parallel').click(); await new Promise(r=>setTimeout(r,800));
      out.push({name:it.textContent.trim().slice(0,20), meta:cur, zhPages:par, textBlocks:document.querySelectorAll('#reader-content .blk').length});
    }
    return JSON.stringify(out);
  })()`);
  console.log(r1);
  console.log('errors:', errs.length ? errs.slice(0, 6) : 'none');
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
