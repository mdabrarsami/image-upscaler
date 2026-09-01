/*
 * Minimal Electron host.
 *
 * The point of this example is what it does *not* contain: no Electron-specific
 * build of the library, no shim, no forked code path. Electron's renderer is
 * Chromium, and the library's environment adapters already cover it, so the
 * same ESM bundle a web page loads is the one loaded here.
 *
 * CommonJS (`.cjs`) because Electron's main process is CJS by default and this
 * repo's package.json sets `"type": "module"`.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

/** Set by the test harness so it can read the result without a GUI. */
const HEADLESS = process.env.UPSCALER_ELECTRON_HEADLESS === '1';

function createWindow() {
  const window = new BrowserWindow({
    width: 1000,
    height: 800,
    show: !HEADLESS,
    webPreferences: {
      // Nothing is exposed to the page: the library runs entirely in the
      // renderer's own sandbox, with no Node integration, exactly as it would
      // on the open web.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  void window.loadFile(path.join(__dirname, 'renderer.html'));
  return window;
}

// The renderer posts its result here so `npm start` prints something useful
// and an automated run has a signal to wait on.
ipcMain.on('upscale-result', (_event, payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (HEADLESS) app.quit();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
