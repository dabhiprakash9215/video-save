const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const querystring = require("querystring");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DOWNLOADS = path.join(ROOT, "downloads");
const UPLOADS = path.join(ROOT, "uploads");

fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const ffmpeg = require("ffmpeg-static");
const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/downloads", express.static(DOWNLOADS));

// ----------------------------------------------------
// VidsSave Official Parser API
// ----------------------------------------------------
const VIDSSAVE_API_URL = "https://api.vidssave.com/api/contentsite_api/media/parse";
const VIDSSAVE_AUTH = "20250901majwlqo";
const VIDSSAVE_DOMAIN = "api-ak.vidssave.com";
const VIDSSAVE_ORIGIN = "cache";

function parseMediaApi(videoUrl) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      auth: VIDSSAVE_AUTH,
      domain: VIDSSAVE_DOMAIN,
      origin: VIDSSAVE_ORIGIN,
      link: videoUrl.trim()
    });

    const req = https.request(VIDSSAVE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*"
      },
      timeout: 20000
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json && (json.status === 1 || json.status_code === "success") && json.data) {
            resolve(json.data);
          } else {
            reject(new Error(json.msg || json.message || "Unable to extract video information from link."));
          }
        } catch (err) {
          reject(new Error("Invalid response received from parser API: " + err.message));
        }
      });
    });

    req.on("error", (err) => reject(new Error("Network error connecting to media API: " + err.message)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Media parse request timed out. Please try again."));
    });

    req.write(postData);
    req.end();
  });
}

function youtubeUrlOk(value) {
  try {
    const u = new URL(String(value).trim());
    const h = u.hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"].includes(h);
  } catch {
    return false;
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    apiEndpoint: VIDSSAVE_API_URL,
    ffmpeg: !!ffmpeg,
    platform: process.platform
  });
});

// 1. Video Metadata & Formats List
app.post("/api/info", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !youtubeUrlOk(url)) {
      return res.status(400).json({ error: "Please enter a valid YouTube video URL." });
    }

    const data = await parseMediaApi(url);

    res.json({
      ok: true,
      id: data.id || "",
      title: data.title || "YouTube Video",
      duration: data.duration || 0,
      thumbnail: data.thumbnail || "",
      resources: data.resources || []
    });
  } catch (e) {
    console.error("[/api/info error]", e.message);
    res.status(500).json({ error: e.message || "Failed to parse media" });
  }
});

// 2. Direct Media Download Generation
app.post("/api/download", async (req, res) => {
  try {
    const { url, format, resource_id } = req.body || {};
    if (!url || !youtubeUrlOk(url)) {
      return res.status(400).json({ error: "Please enter a valid YouTube video URL." });
    }

    const data = await parseMediaApi(url);
    const resources = data.resources || [];

    if (!resources.length) {
      return res.status(404).json({ error: "No download streams found for this video." });
    }

    let selected = null;

    // If specific resource_id is requested
    if (resource_id) {
      selected = resources.find(r => r.resource_id === resource_id);
    }

    // Otherwise find best match based on format (MP4 or MP3)
    if (!selected) {
      if (format === "mp3") {
        selected = resources.find(r => r.format === "MP3")
          || resources.find(r => r.type === "audio")
          || resources[0];
      } else {
        const mp4Videos = resources.filter(r => r.format === "MP4" && r.type === "video");
        selected = mp4Videos.find(r => r.quality === "720P")
          || mp4Videos.find(r => r.quality === "1080P")
          || mp4Videos.find(r => r.quality === "480P")
          || mp4Videos.find(r => r.quality === "360P")
          || mp4Videos[0]
          || resources[0];
      }
    }

    if (!selected || !selected.download_url) {
      return res.status(404).json({ error: "Selected download link is not available." });
    }

    const safeTitle = (data.title || "video").replace(/[^\w\s.-]/g, "_").slice(0, 80);
    const ext = (selected.format || format || "mp4").toLowerCase();
    const filename = `${safeTitle}.${ext}`;

    res.json({
      ok: true,
      title: data.title,
      quality: selected.quality,
      format: selected.format,
      filename,
      downloadUrl: selected.download_url
    });
  } catch (e) {
    console.error("[/api/download error]", e.message);
    res.status(500).json({ error: e.message || "Failed to generate download link" });
  }
});

// 3. Local Media Cutter
app.post("/api/cut", upload.single("media"), async (req, res) => {
  let inputPath = null, outputPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "Choose an MP3 or MP4 file." });

    const start = parseTime(req.body.start);
    const end = parseTime(req.body.end);
    if (start < 0 || end <= start) {
      throw new Error("End time must be greater than start time.");
    }

    inputPath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase() || ".mp4";
    const outExt = [".mp3", ".wav"].includes(ext) ? ext : ".mp4";
    const id = crypto.randomBytes(10).toString("hex");
    outputPath = path.join(DOWNLOADS, `${id}${outExt}`);

    const args = [
      "-y",
      "-ss", String(start),
      "-i", inputPath,
      "-t", String(end - start)
    ];

    if (outExt === ".mp3") {
      args.push("-vn", "-c:a", "libmp3lame", "-b:a", "192k");
    } else {
      args.push("-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart");
    }

    args.push(outputPath);

    await new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, args, { windowsHide: true });
      let err = "";
      p.stderr.on("data", d => err += d.toString());
      p.on("error", reject);
      p.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(err || `FFmpeg exited with code ${code}`));
      });
    });

    if (!fs.existsSync(outputPath)) throw new Error("Cut file was not created.");

    try { fs.unlinkSync(inputPath); } catch {}
    res.json({
      ok: true,
      filename: path.basename(outputPath),
      downloadUrl: `/downloads/${encodeURIComponent(path.basename(outputPath))}`
    });
  } catch (e) {
    if (inputPath && fs.existsSync(inputPath)) { try { fs.unlinkSync(inputPath); } catch {} }
    if (outputPath && fs.existsSync(outputPath)) { try { fs.unlinkSync(outputPath); } catch {} }
    console.error("[/api/cut error]", e);
    res.status(500).json({ error: e.message || "FFmpeg cutting failed" });
  }
});

function parseTime(v) {
  if (v === undefined || v === null || v === "") return NaN;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

// Auto-delete temporary cutter files older than 10 minutes
setInterval(() => {
  const cleanDirectory = (dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      const now = Date.now();
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 10 * 60 * 1000) {
          try { fs.unlinkSync(filePath); } catch {}
        }
      }
    } catch (err) {}
  };
  cleanDirectory(DOWNLOADS);
  cleanDirectory(UPLOADS);
}, 5 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log("====================================");
  console.log(" VidsSave API Backend is running");
  console.log(` http://0.0.0.0:${PORT}`);
  console.log("====================================");
});
