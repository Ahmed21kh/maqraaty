const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");

let client = null;

const state = {
  qrImage: null,
  status: "disconnected",
  qrValue: null,
  // set when this machine cannot run WhatsApp at all (no Chrome, e.g. a hosted server)
  unavailable: null,
};

// --- watchdog state ---
let loadingWatchdog = null;
let overallAuthTimeout = null;

const LOADING_STALL_MS = 90_000;  // no loading_screen update in 45s => stuck
const MAX_AUTH_TIME_MS = 180_000; // hard ceiling from QR issued to ready

function clearWatchdogs() {
  if (loadingWatchdog) clearTimeout(loadingWatchdog);
  if (overallAuthTimeout) clearTimeout(overallAuthTimeout);
  loadingWatchdog = null;
  overallAuthTimeout = null;
}

function armLoadingWatchdog(io) {
  if (loadingWatchdog) clearTimeout(loadingWatchdog);
  loadingWatchdog = setTimeout(() => {
    console.error(`loading_screen stalled (no update in ${LOADING_STALL_MS}ms). Rebuilding client.`);
    forceRebuild(io, "loading_stalled");
  }, LOADING_STALL_MS);
}

function armOverallAuthTimeout(io) {
  if (overallAuthTimeout) clearTimeout(overallAuthTimeout);
  overallAuthTimeout = setTimeout(() => {
    console.error(`Auth did not complete within ${MAX_AUTH_TIME_MS}ms. Rebuilding client.`);
    forceRebuild(io, "auth_timeout");
  }, MAX_AUTH_TIME_MS);
}

async function forceRebuild(io, reasonCode) {
  clearWatchdogs();
  io.emit("whatsapp:timeout", { reason: reasonCode });
  io.emit("whatsapp:loading", { loading: false, count: 0 });

  const dying = client;
  client = null; // clear immediately so nothing else tries to use the stale client
  state.status = "disconnected";
  state.qrImage = null;
  state.qrValue = null;

  if (dying) {
    try {
      await dying.destroy();
    } catch (e) {
      console.error("Error destroying stalled client:", e);
    }
  }

  initWhatsApp(io);
}

function initWhatsApp(io) {
  if (client) return client;
  if (state.unavailable) return null; // no point retrying: Chrome is not installed here

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "maqraaty-main",
      dataPath: "./.wwebjs_auth",
      rmMaxRetries: 4,
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
      ],
      channel: "chrome",
    },
    webVersionCache: { type: "none" }, // switched from the pinned alpha build
  });

  client.on("qr", async (qr) => {
    armOverallAuthTimeout(io); // start the ceiling clock once a QR is issued
    const qrImage = await qrcode.toDataURL(qr);
    state.qrImage = qrImage;
    state.qrValue = qr;
    state.status = "disconnected";
    io.emit("whatsapp:qr", { qrImage, qrValue: qr });
    io.emit("whatsapp:loading", { loading: false, count: 0 });
    io.emit("whatsapp:loading_qr", {loading: false});
  });

  client.on("ready", () => {
    console.log(" whatsapp ready ");
    clearWatchdogs(); // success — cancel both timers
    state.status = "connected";
    state.qrImage = null;
    state.qrValue = null;
    io.emit("whatsapp:ready", { status: "connected" });
    io.emit("whatsapp:loading", { loading: false, count: 100 });
    console.log(' client info ' , client?.info);
    
  });

  client.on("loading_screen", (percent, message) => {
    console.log(`Loading: ${percent}% - ${message}`);
    armLoadingWatchdog(io); // reset stall timer — proves it's still alive
    io.emit("whatsapp:loading", { loading: true, count: percent });
  });

  client.on("authenticated", () => {
    console.log("whatsapp authenticated");
    state.status = "authenticated";
    io.emit("whatsapp:authenticated");
    io.emit("whatsapp:loading", { loading: false, count: 100 });
    console.log(' client info ' , client?.info);

  });

  client.on("auth_failure", (msg) => {
    console.log("whatsapp auth failure");
    clearWatchdogs();
    io.emit("whatsapp:auth_failure", { message: msg });
    io.emit("whatsapp:loading", { loading: false, count: 0 });
  });

  client.on("change_state", (s) => {
    console.log(" change state:", s);
  });

  client.on("disconnected", async (reason) => {
    clearWatchdogs();
    state.status = "disconnected";
    state.qrImage = null;
    state.qrValue = null;
    io.emit("whatsapp:disconnected", { reason });
    io.emit("whatsapp:loading", { loading: false, count: 0 });

    const dying = client;
    client = null;
    try {
      await dying.destroy();
    } catch (e) {
      console.error("Error destroying client:", e);
    }
  });

  client.on("message", (message) => {
    // ...
  });

  client.initialize().catch((err) => {
    console.error("WhatsApp client failed to initialize:", err);
    if (/Could not find (Google )?Chrome|Could not find browser/i.test(String(err?.message))) {
      // Retrying cannot help and, done in a tight loop, starves a small hosted server. Report it once and stop.
      clearWatchdogs();
      client = null;
      state.status = "disconnected";
      state.unavailable = "WhatsApp غير متاح على هذا السيرفر (المتصفح غير مثبت). شغّله من البرنامج المثبت على الجهاز.";
      io.emit("whatsapp:unavailable", { message: state.unavailable });
      io.emit("whatsapp:loading", { loading: false, count: 0 });
      io.emit("whatsapp:loading_qr", { loading: false });
      return;
    }
    // other failures: rebuild, but not in a tight loop
    setTimeout(() => forceRebuild(io, "initialize_failed"), 15_000);
  });

  return client;
}

function getClient() {
  return client;
}

async function logoutWhatsApp(io) {
  clearWatchdogs(); // stop timers so a mid-logout stall doesn't also trigger a rebuild

  if (!client) {
    io.emit("whatsapp:logout_error", {
      message: "No active client to log out",
    });
    return;
  }

  try {
    io.emit("whatsapp:logout_loading", { loading: true });
    await client.logout();
  } catch (err) {
    console.error("Error during client.logout():", err);
    io.emit("whatsapp:logout_loading", { loading: false });
  }

  try {
    await client.destroy();
  } catch (err) {
    console.error("Error during client.destroy():", err);
    io.emit("whatsapp:logout_loading", { loading: false });
    io.emit("whatsapp:logout_error", {
      message: `Error during client.destroy(): ${err}`,
    });
  }

  const authPath = path.resolve("./.wwebjs_auth");
  try {
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      io.emit("whatsapp:logout_loading", { loading: false });
    }
  } catch (err) {
    console.error("Error clearing auth folder:", err);
    io.emit("whatsapp:logout_loading", { loading: false });
    io.emit("whatsapp:logout_error", {
      message: `Error clearing auth folder: ${err}`,
    });
  }

  state.status = "disconnected";
  state.qrImage = null;
  state.qrValue = null;
  client = null;

  io.emit("whatsapp:logged_out");
  io.emit("whatsapp:loading_qr", {loading: true});

  await sleep(1000);
  initWhatsApp(io);
}

function getState() {
  return state;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBulkMessages(io, socket, recipients, message) {
  const results = [];

  for (let i = 0; i < recipients.length; i++) {
    const rawNumber = recipients[i];
    if (!rawNumber) {
      return
    }
    const cleanNumber = rawNumber?.replace(/[^\d]/g, "");
    
    const chatId = cleanNumber?.startsWith('0') ? `2${cleanNumber}@c.us` : `${cleanNumber}@c.us`;
    console.log({chatId});
    
    try {
      await client.sendMessage(chatId, message);
      results.push({ number: rawNumber, ok: true });
    } catch (err) {
      console.log({err});
      
      results.push({ number: rawNumber, ok: false, error: err.message });
    }

    socket.emit("whatsapp:bulk_progress", {
      current: i + 1,
      total: recipients.length,
      results,
    });

    const delay = 2000 + Math.random() * 3000;
    await sleep(delay);
  }

  socket.emit("whatsapp:bulk_done", { results });
}

module.exports = {
  initWhatsApp,
  getClient,
  getState,
  sendBulkMessages,
  logoutWhatsApp,
};