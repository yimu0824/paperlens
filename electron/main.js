/**
 * PaperLens 桌面端主进程
 * 启动本地服务 → 打开应用窗口；提供 PDF 导出（printToPDF）与打开目录能力。
 */
'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server/server');

/* 注意：不要禁用硬件加速 —— 部分 Windows 显卡驱动 + 微软拼音组合下，
   禁用 GPU 会导致输入法(TSF)组合输入失效，表现为输入框"无法打字" */

let win = null;

/* 数据目录：开发时用项目内 data；打包后优先 exe 同级 data（可写），否则退回用户数据目录，
   避免向只读的 app.asar 写入。 */
function resolveDataPaths() {
  const userData = app.getPath('userData');
  if (!app.isPackaged) {
    const root = path.join(__dirname, '..');
    return { runtimeFile: path.join(root, 'config.runtime.json'), baseDataDir: path.join(root, 'data') };
  }
  /* 便携版会被解压到临时目录运行，PORTABLE_EXECUTABLE_DIR 才是 exe 真实所在目录 */
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  let base = path.join(userData, 'data');
  try {
    const probe = path.join(exeDir, 'data');
    fs.mkdirSync(probe, { recursive: true });
    fs.accessSync(probe, fs.constants.W_OK);
    base = probe;
  } catch (e) { /* 安装目录不可写，用用户目录 */ }
  return { runtimeFile: path.join(userData, 'runtime.json'), baseDataDir: base };
}

async function createWindow() {
  console.log('[boot] 1/4 启动本地服务…');
  const { port } = await startServer({ silent: false, ...resolveDataPaths() });
  console.log('[boot] 2/4 创建窗口…');
  win = new BrowserWindow({
    width: 1560, height: 950, minWidth: 1080, minHeight: 660,
    show: true, backgroundColor: '#e9eef7',
    title: 'PaperLens · 论文研读台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer][${level}] ${message}  (${(sourceId || '').split('/').pop()}:${line})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`[renderer] 页面加载失败 ${code} ${desc} ${url}`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[renderer] 渲染进程异常退出:', details.reason);
  });
  /* 窗口显示与焦点：页面就绪即前置，保证输入法(IME)上下文正确绑定 */
  win.webContents.once('did-finish-load', () => {
    try { if (!win.isVisible()) win.show(); win.focus(); console.log('[boot] 4/4 窗口已显示并聚焦'); } catch (e) {}
  });
  setTimeout(() => { try { if (win && !win.isVisible()) win.show(); } catch (e) {} }, 6000);
  /* IME 自愈：窗口重新获焦时让 webContents 重新接管键盘，避免切换窗口后输入法失效 */
  win.on('focus', () => { try { win.webContents.focus(); } catch (e) {} });
  /* 诊断模式：PL_CAPTURE=<png路径> 时启动后自检并退出（用于无头自检） */
  if (process.env.PL_CAPTURE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const dom = await win.webContents.executeJavaScript(`(async () => {
            const r = { zones: document.querySelectorAll('.zone').length, desktopBridge: !!window.paperlensDesktop };
            document.querySelector('#btn-settings').click();
            await new Promise(r2 => setTimeout(r2, 300));
            document.querySelector('.mtab[data-mtab="storage"]').click();
            await new Promise(r2 => setTimeout(r2, 500));
            r.dataRootShown = (document.querySelector('#data-root') || {}).textContent || '(空)';
            document.querySelector('#btn-dataroot-change').click();
            await new Promise(r2 => setTimeout(r2, 400));
            r.modifyDialogAppeared = !!document.querySelector('.dlg-mask');
            const c = document.querySelector('.dlg-cancel'); if (c) c.click();
            await new Promise(r2 => setTimeout(r2, 200));
            document.querySelector('#btn-modal-close').click();
            await new Promise(r2 => setTimeout(r2, 200));
            /* 弹窗已关：打开第一篇文献验证阅读区 */
            const fi = document.querySelector('.file-item');
            if (fi) { fi.click(); await new Promise(r2 => setTimeout(r2, 1500)); }
            r.fileOpened = !!document.querySelector('#reader-content .blk');
            const rt = document.querySelector('#reader-content .t-en');
            r.readerPreview = rt ? rt.textContent.slice(0, 70) : '(空)';
            r.errToasts = document.querySelectorAll('.toast.err').length;
            return JSON.stringify(r);
          })()`);
          console.log('[diag] DOM:', dom);
        } catch (e) { console.error('[diag] failed:', e.message); }
        try {
          const ok = await Promise.race([
            win.webContents.capturePage().then(img => { fs.writeFileSync(process.env.PL_CAPTURE, img.toPNG()); return true; }),
            new Promise(r => setTimeout(() => r(false), 6000))
          ]);
          console.log(ok ? '[capture] saved: ' + process.env.PL_CAPTURE : '[capture] 超时跳过');
        } catch (e) { console.error('[capture] failed:', e.message); }
        app.quit();
      }, 3000);
    });
  }
  console.log('[boot] 3/4 加载页面 http://127.0.0.1:' + port);
  await win.loadURL(`http://127.0.0.1:${port}`);
  win.on('closed', () => { win = null; });
}

/* PDF 导出：隐藏窗口加载打印版 HTML → printToPDF */
ipcMain.handle('pl-export-pdf', async (e, { htmlPath, pdfPath }) => {
  let w = null;
  try {
    w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    await w.loadFile(htmlPath);
    const buf = await w.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    });
    await fs.promises.writeFile(pdfPath, buf);
    return { ok: true, out: pdfPath };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (w) { try { w.destroy(); } catch (x) {} }
  }
});

ipcMain.handle('pl-open-path', async (e, p) => {
  try { await shell.openPath(p); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

/* 原生文件夹选择对话框（数据目录修改用） */
ipcMain.handle('pl-pick-folder', async (e, { current } = {}) => {
  try {
    const parent = BrowserWindow.fromWebContents(e.sender) || win;
    const r = await dialog.showOpenDialog(parent, {
      title: '选择数据目录',
      defaultPath: current || undefined,
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
app.on('window-all-closed', () => app.quit());
