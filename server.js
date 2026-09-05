"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  isValidYouTubeUrl,
  validateFormat,
  validateQuality,
  parseTimestamp
} = require("./src/utils/validator");
const { mapError, ERROR_CODES } = require("./src/utils/error-mapper");
const {
  getDiagnostics,
  fetchMetadata,
  trimMedia,
  DOWNLOAD_DIR,
  TEMP_DIR,
  getYtDlpPath,
  getFfmpegPath
} = require("./src/services/downloader");
const jobManager = require("./src/services/job-manager");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;

// Multer storage for media cutter
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max file upload
});

// Basic CORS Middleware (Supports Vercel frontend or any configured origin)
app.use((req, res, next) => {
  const allowedOrigin = process.env.CORS_ORIGIN || "*";
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "SAMEORIGIN");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Simple in-memory rate limiter per IP
const rateLimits = new Map();
function rateLimiter(maxPerWindow = 60, windowMs = 60000) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const record = rateLimits.get(ip) || { count: 0, resetTime: now + windowMs };

    if (now > record.resetTime) {
      record.count = 1;
      record.resetTime = now + windowMs;
    } else {
      record.count++;
    }
    rateLimits.set(ip, record);

    if (record.count > maxPerWindow) {
      return res.status(429).json({
        success: false,
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: "Too many requests. Please slow down."
      });
    }
    next();
  };
}

// Clean up stale rate limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimits.entries()) {
    if (now > rec.resetTime) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

app.use(express.json({ limit: "1mb" }));
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Serve static frontend files
app.use(express.static(path.join(ROOT, "public")));

// ==========================================
// 1. HEALTH & DIAGNOSTICS ENDPOINTS
// ==========================================
async function handleHealth(req, res) {
  try {
    const diagnostics = await getDiagnostics();
    const stats = jobManager.getStats();

    const isHealthy = diagnostics.ytDlp.available && diagnostics.directories.downloadsWritable;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      diagnostics,
      queue: stats
    });
  } catch (err) {
    res.status(500).json({
      status: "unhealthy",
      error: "Diagnostics check failed"
    });
  }
}

app.get("/health", handleHealth);
app.get("/api/health", handleHealth);

// ==========================================
// 2. VIDEO METADATA ENDPOINT
// ==========================================
app.post("/api/info", rateLimiter(40, 60000), async (req, res) => {
  const { url } = req.body || {};

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({
      success: false,
      code: ERROR_CODES.INVALID_URL,
      message: "Please enter a valid YouTube video URL."
    });
  }

  try {
    const info = await fetchMetadata(url);
    res.json({
      success: true,
      ...info
    });
  } catch (err) {
    const mapped = mapError(err);
    res.status(400).json(mapped);
  }
});

// ==========================================
// 3. JOB-BASED ASYNC DOWNLOAD ENDPOINTS
// ==========================================

/**
 * POST /api/download
 * Creates a media download job and returns jobId
 */
app.post("/api/download", rateLimiter(20, 60000), async (req, res) => {
  const { url, format, quality, title } = req.body || {};

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({
      success: false,
      code: ERROR_CODES.INVALID_URL,
      message: "Please provide a valid YouTube URL."
    });
  }

  const validFmt = validateFormat(format);
  const validQual = validateQuality(quality);

  const job = jobManager.createJob({
    url: url.trim(),
    format: validFmt,
    quality: validQual,
    title: title ? String(title).slice(0, 150) : ""
  });

  res.status(202).json({
    success: true,
    jobId: job.id,
    status: job.status,
    message: "Download job queued successfully."
  });
});

/**
 * GET /api/download/:jobId
 * Polls the status and progress of a download job
 */
app.get("/api/download/:jobId", rateLimiter(120, 60000), (req, res) => {
  const { jobId } = req.params;
  const job = jobManager.getJob(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      code: "JOB_NOT_FOUND",
      message: "Download job was not found or has expired."
    });
  }

  res.json(job);
});

/**
 * GET /api/download/:jobId/file
 * Streams the completed media file to client and schedules cleanup
 */
app.get("/api/download/:jobId/file", (req, res) => {
  const { jobId } = req.params;
  const rawJob = jobManager.jobs.get(jobId);

  if (!rawJob || rawJob.status !== "completed" || !rawJob.filePath) {
    return res.status(404).json({
      success: false,
      code: "FILE_NOT_READY",
      message: "File is not ready or has expired. Please start a new download."
    });
  }

  if (!fs.existsSync(rawJob.filePath)) {
    return res.status(404).json({
      success: false,
      code: "FILE_NOT_FOUND",
      message: "Media file was removed or expired."
    });
  }

  const safeFilename = path.basename(rawJob.filename || `${rawJob.id}.${rawJob.format}`);
  const isAudio = rawJob.format === "mp3";
  const contentType = isAudio ? "audio/mpeg" : "video/mp4";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeFilename)}"`);

  res.download(rawJob.filePath, safeFilename, (err) => {
    if (!err) {
      // Schedule safe deletion 5 seconds after streaming ends
      jobManager.scheduleFileDeletion(jobId, 5000);
    }
  });
});

// Legacy direct download endpoint compatibility (redirects/wraps)
app.get("/downloads/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DOWNLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "Download link expired or file not found."
    });
  }

  res.download(filePath, filename, (err) => {
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { }
    }, 4000);
  });
});

// ==========================================
// 4. MEDIA CUTTER ENDPOINT
// ==========================================
app.post("/api/cut", rateLimiter(10, 60000), upload.single("media"), async (req, res) => {
  let uploadedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please choose an audio or video file to cut."
      });
    }

    uploadedPath = req.file.path;
    const start = parseTimestamp(req.body.start);
    const end = parseTimestamp(req.body.end);

    if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
      throw new Error("End time must be greater than start time.");
    }

    const result = await trimMedia(uploadedPath, start, end, req.file.originalname);

    // Clean up uploaded original file immediately
    try { fs.unlinkSync(uploadedPath); } catch { }

    res.json({
      success: true,
      filename: result.filename,
      downloadUrl: `/downloads/${encodeURIComponent(result.filename)}`
    });
  } catch (err) {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch { }
    }
    const mapped = mapError(err);
    res.status(500).json(mapped);
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found."
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  const mapped = mapError(err);
  res.status(500).json(mapped);
});

// ==========================================
// 5. SERVER INITIALIZATION & DIAGNOSTICS
// ==========================================
async function startServer() {
  // Pre-initialize binaries
  try {
    const ytBin = await getYtDlpPath();
    const ffBin = getFfmpegPath();
    console.log("[VidsSave Backend] Initializing...");
    console.log(`[VidsSave Backend] yt-dlp binary: ${ytBin || "None"}`);
    console.log(`[VidsSave Backend] FFmpeg binary: ${ffBin || "None"}`);
  } catch (e) {
    console.warn("[VidsSave Backend] Startup check warning:", e.message);
  }

  const server = app.listen(PORT, HOST, () => {
    console.log("=================================================");
    console.log(`  🚀 VidsSave Dedicated Media Backend Running`);
    console.log(`  🌐 Address: http://${HOST}:${PORT}`);
    console.log(`  🩺 Health:  http://${HOST}:${PORT}/health`);
    console.log(`  📦 Storage: ${DOWNLOAD_DIR}`);
    console.log("=================================================");
  });

  // Graceful shutdown
  const shutdownHandler = (signal) => {
    console.log(`\n[VidsSave Backend] Received ${signal}. Shutting down gracefully...`);
    jobManager.shutdown();
    server.close(() => {
      console.log("[VidsSave Backend] HTTP server closed.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
  process.on("SIGINT", () => shutdownHandler("SIGINT"));

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = app;
