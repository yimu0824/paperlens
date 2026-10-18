'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paperlensDesktop', {
  isDesktop: true,
  exportPDF: (htmlPath, pdfPath) => ipcRenderer.invoke('pl-export-pdf', { htmlPath, pdfPath }),
  openPath: p => ipcRenderer.invoke('pl-open-path', p),
  pickFolder: current => ipcRenderer.invoke('pl-pick-folder', { current })
});
