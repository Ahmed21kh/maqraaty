const { app, BrowserWindow, screen } = require("electron/main");
const path = require("node:path");
const fs = require("fs");

if (!app.isPackaged) {
  try {
    require("electron-reloader")(module);
  } catch {}
}

function createWindow() {
  const size = screen.getPrimaryDisplay().workAreaSize;
  let win = new BrowserWindow({
    width: size.width,
    height: size.height,
    icon: `file://${__dirname}/dist/maqraaty_2/browser/favicon.ico`,
    fullscreenable: true,
    webPreferences: {
      nodeIntegration: true,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      enableRemoteModule: true,
      webviewTag: true,
    },
  });

  console.log(__dirname);

  const indexPath = path.join(__dirname, "dist/maqraaty_2/browser", "index.html");
  if (fs.existsSync(indexPath)) {
    win.loadFile(indexPath);
  }

  if (!app.isPackaged) {
    require("electron-reload")(__dirname);
  }

  win.setIcon(path.join(__dirname, "dist/maqraaty_2/browser", "favicon.ico"));

  win.on("closed", function () {
    win = null;
  });
}

// running this file starts the backend immediately (top-level code in app.js executes on require)
require("./app.js");

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

if (require("electron-squirrel-startup")) app.quit();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});