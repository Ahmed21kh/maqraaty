  const express = require("express");
  const mongoose = require("mongoose");
  const cors = require("cors");
  const path = require("path");
  const bodyparser = require("body-parser");
  const fs = require("fs");
  const http = require("http");
  const { Server } = require("socket.io");
  const studentRoutes = require("./routes/studentsWithMongoose");
  const { initWhatsApp, getClient, getState, sendBulkMessages , logoutWhatsApp } = require("./services/whatsapp.service");

  const app = express();
  const server = http.createServer(app); // wrap express in an http server
  const io = new Server(server, {
    cors: { origin: "*" },
    transports: ["polling", "websocket"],
    pingTimeout: 30000,   // default is 20000ms — give it more slack
    pingInterval: 25000,
  });

  // Database: hosted deployments (Render) must set MONGODB_URI to the MongoDB Atlas connection string
  // (Render dashboard -> Environment); on a PC it falls back to the local MongoDB.
  const url = process.env.MONGODB_URI || "mongodb://localhost:27017/Maqraaty";
  if (process.env.RENDER && !process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set. Add it in the Render dashboard (Environment) and redeploy.");
    process.exit(1);
  }

  app.use(bodyparser.json());
  app.use(cors());

  const folderPath1 = path.join(__dirname, "uploads");
  if (!fs.existsSync(folderPath1)) {
    fs.mkdirSync(folderPath1, { recursive: true });
  }
  app.use("/uploads", express.static("uploads"));

  const distPath = path.join(__dirname, "dist/maqraaty_2/browser");
  // The desktop app serves the bundled Angular build. A hosted API (Render) does not: the UI lives on Vercel,
  // and a half-deployed copy of it only produced a blank page with "MIME type text/html" script errors.
  const serveUi = !process.env.RENDER && fs.existsSync(path.join(distPath, "index.html"));
  if (serveUi) app.use(express.static(distPath));

  app.use("/api", studentRoutes);

  if (serveUi) {
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    app.get("/", (req, res) => res.json({ status: "ok", service: "maqraaty-api" }));
    app.use((req, res) => res.status(404).json({ message: "Not found" }));
  }

  io.on("connection", (socket) => {
    console.log("Angular client connected:", socket.id);
    
    // send current state right away so a newly connected/reconnected client is caught up
    const { status , qrValue, unavailable } = getState();
    if (unavailable) {
      socket.emit("whatsapp:unavailable", { message: unavailable });
      socket.emit("whatsapp:loading_qr", { loading: false });
    } else if (qrValue) {
      socket.emit("whatsapp:qr", qrValue);
    }else {
      io.emit("whatsapp:loading_qr", {loading: true});
    }
    if (status === "connected") {
      socket.emit("whatsapp:ready", { status: "connected" });
    } else if (status === "authenticated") {
      socket.emit("whatsapp:authenticated");
    }

    socket.on("whatsapp:send", async ({ to, message }) => {
      try {
        const activeClient = getClient();
        if (!activeClient) {
          return socket.emit("whatsapp:send_ack", { ok: false, error: "WhatsApp not initialized" });
        }
          console.log({to , message});
          
        const chatId = to.includes("@c.us") ? to : `${to}@c.us`;
    
        // isRegisteredUser/getNumberId is currently broken upstream — skip it
        await activeClient.sendMessage(chatId, message);
        socket.emit("whatsapp:send_ack", { ok: true });
      } catch (err) {
        console.error("sendMessage error:", err);
        socket.emit("whatsapp:send_ack", { ok: false, error: err.message });
      }
    });

    socket.on("whatsapp:send_bulk", async ({ recipients, message }) => {
      const activeClient = getClient();
      if (!activeClient) {
        return socket.emit("whatsapp:bulk_done", { error: "WhatsApp not initialized" });
      }
      await sendBulkMessages(io, socket, recipients, message);
    });

    socket.on('disconnect', (reason) => {
      console.log('socket disconnected:', reason);
    });

    socket.on("whatsapp:logout", async () => {
      await logoutWhatsApp(io);
    });
  });

  const errorLogPath = path.join(__dirname, 'server-errors.log');
  function logToFile(msg) {
    fs.appendFileSync(errorLogPath, `${new Date().toISOString()} ${msg}\n`);
  }
  
  io.engine.on("connection_error", (err) => {
    logToFile(`connection_error code=${err.code} message=${err.message} context=${JSON.stringify(err.context)}`);
  });

  process.on('unhandledRejection', (reason) => {
    let activeClient = getClient();
    console.error('Unhandled Rejection (WhatsApp):', reason);
    if (reason?.message?.includes('detached Frame')) {
      console.log('Detached frame detected, forcing client rebuild...');
      if (activeClient) {
        activeClient.destroy().catch(() => {});
      }
      activeClient = null;
      initWhatsApp(io); // rebuild from scratch
    }
  });

  io.on('disconnect', (reason) => {
    console.log('socket disconnected:', reason);
    let activeClient = getClient();
    if (activeClient) {
      activeClient.destroy().catch(() => {});
    }
    activeClient = null;
  });

  let whatsappClient;

  const PORT = process.env.PORT || 8000;

  const startServer = async () => {
    try {
      await mongoose.connect(url);
      console.log("Connected to MongoDB Successfully");

      // WhatsApp needs Chrome; on a host without it (or with WHATSAPP_ENABLED=false) the API still starts.
      if (process.env.WHATSAPP_ENABLED !== "false") {
        try {
          whatsappClient = initWhatsApp(io);
        } catch (e) {
          console.error("WhatsApp bridge not started:", e.message);
        }
      }

      server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
      });
    } catch (error) {
      console.error("Database connection failed:", error);
      process.exitCode = 1;
    }
  };

  startServer();