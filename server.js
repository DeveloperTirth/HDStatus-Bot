const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const ffprobeStatic = require("ffprobe-static");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ── CONFIGURATION ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000; // default to port 3000 as the sole server
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "Tirth162009isbestdeveloper";

// Auth directory for Baileys session persistence
const tempDir = os.tmpdir();
const AUTH_DIR = fs.existsSync("/data")
  ? "/data/wa-bot-auth"
  : path.join(tempDir, "wa-bot-auth");

// Directory to store pre-compressed video segments locally
const OUTPUT_DIR = path.join(__dirname, "outputs");
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Temporary directory for multi-part file uploads
const uploadDir = path.join(tempDir, "wa-bot-uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

// In-memory jobs store for registered pre-compressed videos
const jobs = {};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Admin authentication middleware
const checkAdminKey = (req, res, next) => {
  const key = req.query.key || req.body.key || req.headers["x-admin-key"];
  if (key !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized: Invalid admin key" });
  }
  next();
};

// ── WHATSAPP BOT SERVICE USING BAILEYS ──────────────────────────────────────
let sock = null;
let qrCodeData = null;
let connectionStatus = "disconnected"; // "disconnected", "connecting", "qr", "connected"
let connectedUser = null;

const SERVER_STARTUP_TIME = Math.floor(Date.now() / 1000);

// Helper to clean JIDs (preserves domain, e.g. @s.whatsapp.net)
function cleanJid(jid) {
  if (!jid) return "";
  const parts = jid.split("@");
  const user = parts[0].split(":")[0];
  const domain = parts[1] || "s.whatsapp.net";
  return `${user}@${domain}`;
}

// Robust caption/text message parser
function getMessageText(m) {
  if (!m) return "";
  if (m.ephemeralMessage?.message) return getMessageText(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return getMessageText(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return getMessageText(m.viewOnceMessageV2.message);
  if (m.documentWithCaptionMessage?.message) return getMessageText(m.documentWithCaptionMessage.message);
  
  return m.conversation || 
         m.extendedTextMessage?.text || 
         m.imageMessage?.caption || 
         m.videoMessage?.caption || 
         "";
}

// Send standard text message using relayMessage
async function sendTextMessage(jid, text) {
  if (!sock) throw new Error("WhatsApp socket not connected");
  const messageId = "HDSTATUS_" + Math.random().toString(36).substring(2, 10).toUpperCase();
  await sock.relayMessage(jid, { conversation: text }, { messageId });
}

// Start/Initialize WASocket
async function startWASock() {
  try {
    const { useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
    const makeWASocket = require("@whiskeysockets/baileys").default;
    const pino = require("pino");
    const QRCode = require("qrcode");

    console.log(`[Bot] Initializing auth store in: ${AUTH_DIR}`);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
    });
    
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        connectionStatus = "qr";
        try {
          qrCodeData = await QRCode.toDataURL(qr);
        } catch (err) {
          console.error("[Bot] Failed to generate QR data URL:", err);
        }
      }
      
      if (connection === "connecting") {
        connectionStatus = "connecting";
        qrCodeData = null;
      }
      
      if (connection === "open") {
        connectionStatus = "connected";
        qrCodeData = null;
        connectedUser = sock.user.id.split(":")[0].split("@")[0];
        console.log(`[Bot] WhatsApp connection successfully opened! Connected as +${connectedUser}`);
      }
      
      if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`[Bot] Connection closed due to:`, lastDisconnect?.error?.message, `, reconnecting:`, shouldReconnect);
        
        connectionStatus = "disconnected";
        connectedUser = null;
        qrCodeData = null;
        
        if (shouldReconnect) {
          setTimeout(startWASock, 3000);
        } else {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (_) {}
          setTimeout(startWASock, 1000);
        }
      }
    });
    
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (upsert) => {
      try {
        const { messages, type } = upsert;
        if ((type !== "notify" && type !== "append") || !messages || messages.length === 0) return;

        const msg = messages[0];
        const senderJid = cleanJid(msg.key.remoteJid);

        // Ignore messages older than server startup time
        const msgTime = msg.messageTimestamp;
        if (msgTime && msgTime < SERVER_STARTUP_TIME - 120) {
          return;
        }

        const text = getMessageText(msg.message).trim();
        if (!text.toUpperCase().startsWith("SEND ")) return;

        const jobId = text.substring(5).trim();
        console.log(`[Bot] Processing SEND command for jobId: ${jobId} from ${senderJid}`);

        const job = jobs[jobId];
        if (!job) {
          console.log(`[Bot] Job ID ${jobId} not found in local registry.`);
          await sendTextMessage(senderJid, "❌ Code expired or not found. Please upload the video again on the dashboard to get a new code.");
          return;
        }

        // Notify transfer start
        console.log(`[Bot] Job found. Relaying ${job.segments.length} segment(s) to ${senderJid}`);
        await sendTextMessage(senderJid, `🚀 Transferring ${job.segments.length} optimized clip(s) in HD...`);

        const { generateWAMessage } = require("@whiskeysockets/baileys");

        for (const seg of job.segments) {
          if (!fs.existsSync(seg.outputPath)) {
            console.log(`[Bot] Segment file not found: ${seg.outputPath}`);
            await sendTextMessage(senderJid, `❌ Part ${seg.part} has expired on the server.`);
            continue;
          }

          console.log(`[Bot] Preparing segment ${seg.part} from local file: ${seg.outputPath}`);
          const caption = `🎥 Part ${seg.part} of your optimized video (${seg.outputSizeMB?.toFixed(2)}MB)\n\n👉 Forward this message directly to "My Status" to bypass client-side compression completely!`;

          // Generate WAMessage by pointing it directly to the local segment path
          let outMsg;
          try {
            outMsg = await generateWAMessage(senderJid, {
              video: { url: seg.outputPath },
              caption,
              mimetype: "video/mp4",
            }, {
              userJid: sock.user.id,
              upload: sock.waUploadToServer
            });
          } catch (genErr) {
            console.error(`[Bot] Failed to generate WAMessage for segment ${seg.part}:`, genErr);
            await sendTextMessage(senderJid, `❌ Failed to prepare Part ${seg.part} segment.`);
            continue;
          }

          // Inject HD metadata
          if (outMsg.message && outMsg.message.videoMessage) {
            const videoMsg = outMsg.message.videoMessage;
            const seconds = videoMsg.seconds || Math.round(seg.duration || 29);
            const bitrateBps = Math.round((videoMsg.fileLength * 8) / seconds);

            videoMsg.processedVideos = [
              {
                directPath: videoMsg.directPath,
                fileSha256: videoMsg.fileSha256,
                height: videoMsg.height || seg.height || 720,
                width: videoMsg.width || seg.width || 1280,
                fileLength: videoMsg.fileLength,
                bitrate: bitrateBps,
                quality: 3, // HIGH quality flag
              }
            ];
            console.log(`[Bot] Injected HD processedVideos metadata for segment ${seg.part}`);
          }

          // Relay the message
          try {
            await sock.relayMessage(senderJid, outMsg.message, { messageId: outMsg.key.id });
            console.log(`[Bot] Sent part ${seg.part} successfully to ${senderJid}`);
          } catch (relayErr) {
            console.error(`[Bot] Failed to relay part ${seg.part}:`, relayErr);
          }

          // 2-second rate-limiting delay between video uploads
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

      } catch (err) {
        console.error("[Bot] Error handling messages.upsert:", err);
      }
    });

  } catch (err) {
    console.error("[Bot] Failed to start WhatsApp socket loop:", err);
    setTimeout(startWASock, 5000);
  }
}

// ── EXPRESS API ENDPOINTS ───────────────────────────────────────────────────

// Serve admin pairing console
app.get(["/", "/admin", "/admin.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// GET /bot/status
app.get("/bot/status", checkAdminKey, (req, res) => {
  res.json({
    status: connectionStatus,
    user: connectedUser,
    connected: connectionStatus === "connected"
  });
});

// GET /bot/qr
app.get("/bot/qr", checkAdminKey, (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({ status: "connected", user: connectedUser });
  }
  if (!qrCodeData) {
    return res.status(404).json({ error: "QR code not generated yet" });
  }
  res.json({ status: connectionStatus, qr: qrCodeData });
});

// GET & POST /bot/logout
const handleLogout = async (req, res) => {
  try {
    console.log("[Bot] Logging out and unlinking WhatsApp device...");
    connectionStatus = "disconnected";
    connectedUser = null;
    qrCodeData = null;
    
    if (sock) {
      await sock.logout();
    }
    
    // Clear session auth files
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    } catch (_) {}

    res.json({ success: true });
  } catch (err) {
    console.error("[Bot] Logout failed:", err);
    res.status(500).json({ error: err.message });
  }
};

app.get("/bot/logout", checkAdminKey, handleLogout);
app.post("/bot/logout", checkAdminKey, handleLogout);

// POST /compress/precompressed
// Receives pre-compressed videos uploaded from the Android app, stores them locally,
// extracts their dimensions/duration via ffprobe, and registers them under a new jobId.
app.post("/compress/precompressed", checkAdminKey, upload.array("videos"), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No video files provided" });
  }

  const jobId = uuidv4();
  const segments = [];

  console.log(`[Bot] Registering precompressed videos for Job ID ${jobId}. Parts: ${req.files.length}`);

  for (let idx = 0; idx < req.files.length; idx++) {
    const file = req.files[idx];
    const partNum = idx + 1;
    const finalPath = path.join(OUTPUT_DIR, `${jobId}_part${partNum}.mp4`);
    
    try {
      fs.renameSync(file.path, finalPath);
    } catch (err) {
      if (err.code === "EXDEV") {
        try {
          fs.copyFileSync(file.path, finalPath);
          fs.unlinkSync(file.path);
        } catch (copyErr) {
          console.error("[Bot] Failed to copy segment file after EXDEV:", copyErr);
          req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
          return res.status(500).json({ error: "Failed to store segment files via copy" });
        }
      } else {
        console.error("[Bot] Failed to move segment file:", err);
        // Clean up uploaded temp files
        req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
        return res.status(500).json({ error: "Failed to store segment files" });
      }
    }

    const fileSizeMB = fs.statSync(finalPath).size / (1024 * 1024);

    // Extract metadata using ffprobe
    const metadata = await new Promise((resolve) => {
      execFile(
        ffprobeStatic.path,
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height,duration",
          "-of", "json",
          finalPath,
        ],
        (err, stdout) => {
          if (err) {
            console.error(`[Bot] ffprobe error on segment ${partNum}:`, err);
            return resolve({ width: 720, height: 1280, duration: 29.0 });
          }
          try {
            const parsed = JSON.parse(stdout);
            const stream = parsed.streams?.[0] || {};
            resolve({
              width: parseInt(stream.width) || 720,
              height: parseInt(stream.height) || 1280,
              duration: parseFloat(stream.duration) || 29.0,
            });
          } catch (e) {
            resolve({ width: 720, height: 1280, duration: 29.0 });
          }
        }
      );
    });

    segments.push({
      part: partNum,
      outputPath: finalPath,
      outputSizeMB: fileSizeMB,
      width: metadata.width,
      height: metadata.height,
      duration: metadata.duration,
    });
  }

  jobs[jobId] = {
    status: "done",
    progress: 100,
    segments,
    totalParts: segments.length,
    createdAt: Date.now(),
  };

  console.log(`[Bot] Job ${jobId} registered with ${segments.length} segments.`);
  res.json({ success: true, jobId });
});

// GET /status/:jobId (compatibility endpoint for status checks)
app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.json({
    status: job.status,
    progress: job.progress,
    totalParts: job.totalParts,
    segments: job.segments.map((seg) => ({
      part: seg.part,
      status: "done",
      progress: 100,
      outputSizeMB: seg.outputSizeMB,
      width: seg.width,
      height: seg.height,
      duration: seg.duration,
    })),
  });
});

// POST /bot/send-precompressed (direct send helper)
app.post("/bot/send-precompressed", checkAdminKey, upload.single("video"), async (req, res) => {
  const { phone } = req.body;
  if (!req.file) {
    return res.status(400).json({ error: "Missing video file upload" });
  }
  if (!phone) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: "Missing recipient phone number" });
  }

  if (connectionStatus !== "connected" || !sock) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(412).json({ error: "WhatsApp Bot is not connected" });
  }

  const tempFilePath = req.file.path;

  try {
    const { generateWAMessage } = require("@whiskeysockets/baileys");
    
    const cleanPhone = phone.replace(/\D/g, "");
    if (cleanPhone.length === 0) {
      throw new Error("Invalid phone number format");
    }
    const jid = cleanPhone + "@s.whatsapp.net";

    // Run ffprobe to get duration, width, height
    const metadata = await new Promise((resolve, reject) => {
      execFile(
        ffprobeStatic.path,
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height,duration",
          "-of", "json",
          tempFilePath,
        ],
        (err, stdout) => {
          if (err) return reject(err);
          try {
            const parsed = JSON.parse(stdout);
            const stream = parsed.streams?.[0] || {};
            resolve({
              width: parseInt(stream.width) || 720,
              height: parseInt(stream.height) || 1280,
              duration: parseFloat(stream.duration) || 29.5,
            });
          } catch (e) {
            reject(e);
          }
        }
      );
    });

    console.log(`[Bot-Precompressed] Probed metadata: ${metadata.width}x${metadata.height}, duration: ${metadata.duration}s`);
    const caption = `🎥 Pre-compressed HD status clip (${(req.file.size / (1024 * 1024)).toFixed(2)}MB)\n\n👉 Forward this video directly to "My Status" on your phone to bypass client-side compression completely!`;

    // Generate WAMessage (uploads media)
    const msg = await generateWAMessage(jid, {
      video: { url: tempFilePath },
      caption,
      mimetype: "video/mp4",
    }, {
      userJid: sock.user.id,
      upload: sock.waUploadToServer
    });

    // Inject HD metadata
    if (msg.message && msg.message.videoMessage) {
      const videoMsg = msg.message.videoMessage;
      const seconds = videoMsg.seconds || Math.round(metadata.duration) || 29;
      const bitrateBps = Math.round((videoMsg.fileLength * 8) / seconds);

      videoMsg.processedVideos = [
        {
          directPath: videoMsg.directPath,
          fileSha256: videoMsg.fileSha256,
          height: videoMsg.height || metadata.height,
          width: videoMsg.width || metadata.width,
          fileLength: videoMsg.fileLength,
          bitrate: bitrateBps,
          quality: 3, // HIGH quality flag
        }
      ];
      console.log(`[Bot-Precompressed] Injected HD processedVideos metadata`);
    }

    // Relay message
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    console.log(`[Bot-Precompressed] Direct HD video sent to: ${jid}`);
    res.json({ success: true });

  } catch (err) {
    console.error("[Bot-Precompressed] Direct send failed:", err);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch (_) {}
  }
});

// ── GARBAGE COLLECTION / CLEANUP ───────────────────────────────────────────
// Periodically cleans up segment files and jobs older than 1 hour to prevent disk fill-up
setInterval(() => {
  const now = Date.now();
  const expiryTime = 60 * 60 * 1000; // 1 hour
  
  for (const jobId in jobs) {
    if (now - jobs[jobId].createdAt > expiryTime) {
      console.log(`[Bot] Expiring Job ${jobId} and cleaning output files...`);
      for (const seg of jobs[jobId].segments) {
        try {
          if (fs.existsSync(seg.outputPath)) {
            fs.unlinkSync(seg.outputPath);
          }
        } catch (_) {}
      }
      delete jobs[jobId];
    }
  }
}, 10 * 60 * 1000); // run every 10 minutes

// Start bot and HTTP server listener
startWASock();
app.listen(PORT, () => {
  console.log(`\n🤖 Standalone WhatsApp Bot Server active on port ${PORT}`);
  console.log(`💾 Local uploads directory: ${OUTPUT_DIR}`);
  console.log(`🔐 Admin Token Protection: Enabled\n`);
});
