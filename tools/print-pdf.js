'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const html = process.env.PL_HTML, out = process.env.PL_PDF;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await w.loadFile(html);
  await new Promise(r => setTimeout(r, 1200));
  const buf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  fs.writeFileSync(out, buf);
  console.log('ok', out, buf.length);
  app.quit();
}).catch(e => { console.error(e); app.quit(); });
