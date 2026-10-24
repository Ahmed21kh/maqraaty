const { app, BrowserWindow, Menu, dialog, shell, screen } = require("electron/main");
const path = require("node:path");
const fs = require("fs");

// Squirrel installer events (create/remove shortcuts) must be handled before anything else starts.
if (require("electron-squirrel-startup")) app.quit();

if (!app.isPackaged) {
  try {
    require("electron-reloader")(module);
  } catch {}
}

const APP_NAME = "مقرأتي";
const BACKGROUND = "#0e1116"; // the app's dark surface: no white flash while the window opens
const UI_DIR = path.join(__dirname, "dist/maqraaty_2/browser");

// ───────────────────────────────────────────────────────── one copy at a time
// A second copy would fight the first one for port 8000 and for the WhatsApp session. Opening the app again just
// brings the running window to the front.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let backend = null; // { ready, shutdown } exported by app.js
let quitting = false;

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// ───────────────────────────────────────────────────────── errors
function logError(label, err) {
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${err?.stack || err}\n`;
    fs.appendFileSync(path.join(app.getPath("userData"), "error.log"), line);
  } catch {}
  console.error(label, err);
}
process.on("uncaughtException", (err) => logError("uncaughtException", err));
process.on("unhandledRejection", (err) => logError("unhandledRejection", err));

// ───────────────────────────────────────────────────────── window size / position memory
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  const work = screen.getPrimaryDisplay().workArea;
  const fallback = { width: Math.min(1400, work.width), height: Math.min(860, work.height), maximized: true };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width - 80 && s.x + s.width > a.x + 80 && s.y < a.y + a.height - 80 && s.y + s.height > a.y + 40;
    });
    return Number.isFinite(s.width) && Number.isFinite(s.height) && (s.x === undefined || visible) ? s : fallback;
  } catch {
    return fallback;
  }
}

function trackWindowState(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const bounds = win.getNormalBounds();
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
    } catch {}
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  ["resize", "move", "maximize", "unmaximize"].forEach((e) => win.on(e, later));
  win.on("close", save);
}

// ───────────────────────────────────────────────────────── menu (right-to-left labels, only what is useful)
function buildMenu() {
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "ملف", submenu: [{ label: "خروج", accelerator: "Alt+F4", role: "quit" }] },
      {
        label: "عرض",
        submenu: [
          { label: "تحديث", accelerator: "CmdOrCtrl+R", role: "reload" },
          { type: "separator" },
          { label: "تكبير", accelerator: "CmdOrCtrl+Plus", role: "zoomIn" },
          { label: "تصغير", accelerator: "CmdOrCtrl+-", role: "zoomOut" },
          { label: "الحجم الافتراضي", accelerator: "CmdOrCtrl+0", role: "resetZoom" },
          { type: "separator" },
          { label: "ملء الشاشة", accelerator: "F11", role: "togglefullscreen" },
          ...(dev ? [{ type: "separator" }, { label: "ادوات المطور", accelerator: "F12", role: "toggleDevTools" }] : []),
        ],
      },
      {
        label: "تعديل",
        submenu: [
          { label: "تراجع", role: "undo" },
          { label: "اعادة", role: "redo" },
          { type: "separator" },
          { label: "قص", role: "cut" },
          { label: "نسخ", role: "copy" },
          { label: "لصق", role: "paste" },
          { label: "تحديد الكل", role: "selectAll" },
        ],
      },
    ])
  );
}

// ───────────────────────────────────────────────────────── window
function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 1000,
    minHeight: 640,
    title: APP_NAME,
    backgroundColor: BACKGROUND,
    icon: path.join(UI_DIR, "favicon.ico"),
    autoHideMenuBar: true,
    show: false, // shown once the page has painted
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // the pages never need Node: a compromised page must not be able to reach the file system
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  trackWindowState(win);

  win.once("ready-to-show", () => {
    if (state.maximized) win.maximize();
    win.show();
  });

  // links to other sites open in the browser, never inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  const indexPath = path.join(UI_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    win.loadFile(indexPath);
  } else {
    dialog.showErrorBox(APP_NAME, "ملفات الواجهة غير موجودة. أعد تثبيت البرنامج.");
  }

  if (!app.isPackaged) {
    try {
      require("electron-reload")(__dirname);
    } catch {}
  }

  win.on("closed", () => {
    mainWindow = null;
  });
}

// ───────────────────────────────────────────────────────── start-up / shutdown
function explain(error) {
  const code = error?.code;
  if (code === "EADDRINUSE") return "المنفذ 8000 مستخدم بالفعل. اغلق النسخة الاخرى من البرنامج او اي برنامج يستخدم هذا المنفذ.";
  if (/ECONNREFUSED|MongooseServerSelection|MongoServerSelection|ENOTFOUND/i.test(`${error?.name} ${error?.message} ${code}`)) {
    return "تعذر الاتصال بقاعدة البيانات MongoDB. تأكد من تشغيل MongoDB على الجهاز ثم افتح البرنامج مرة اخرى.";
  }
  return `تعذر تشغيل السيرفر: ${error?.message || error}`;
}

if (gotLock) {
  // running app.js starts the backend straight away (top-level code executes on require)
  try {
    backend = require("./app.js");
  } catch (e) {
    logError("backend require", e);
  }

  app.whenReady().then(async () => {
    buildMenu();

    // the window opens only once the server is up, so the first screen never shows connection errors
    const result = backend?.ready ? await backend.ready : { ok: false, error: new Error("backend not loaded") };
    if (!result.ok) {
      logError("backend start", result.error);
      dialog.showErrorBox(APP_NAME, explain(result.error));
      quitting = true;
      app.quit();
      return;
    }

    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // stop the server, the database connection and the WhatsApp browser before the process exits
  app.on("before-quit", (event) => {
    if (quitting || !backend?.shutdown) return;
    quitting = true;
    event.preventDefault();
    const done = () => app.exit(0);
    Promise.race([backend.shutdown(), new Promise((r) => setTimeout(r, 4000))]).then(done, done);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
