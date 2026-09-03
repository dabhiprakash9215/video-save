const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
const { ensureYtDlp } = require("./setup-bin");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

function resolveWritableDir(sub) {
  try {
    const localDir = path.join(ROOT, sub);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const testFile = path.join(localDir, ".write_test");
    fs.writeFileSync(testFile, "1");
    fs.unlinkSync(testFile);
    return localDir;
  } catch {
    const tmpDir = path.join(os.tmpdir(), "vidssave", sub);
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    return tmpDir;
  }
}

const DOWNLOADS = resolveWritableDir("downloads");
const UPLOADS = resolveWritableDir("uploads");

// Resolve FFmpeg (ffmpeg-static or system ffmpeg)
let ffmpegPath = null;
try {
  let staticPath = require("ffmpeg-static");
  if (staticPath && fs.existsSync(staticPath)) {
    if (process.platform !== "win32") {
      try { fs.chmodSync(staticPath, 0o755); } catch {}
    }
    ffmpegPath = staticPath;
  }
} catch {}

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const out = execSync(cmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out) ffmpegPath = out.split(/\r?\n/)[0].trim();
  } catch {}
}

let activeYtDlpPath = null;

async function getYtDlp() {
  if (activeYtDlpPath && fs.existsSync(activeYtDlpPath)) {
    return activeYtDlpPath;
  }
  activeYtDlpPath = await ensureYtDlp();
  return activeYtDlpPath;
}

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use(express.static(path.join(ROOT, "public")));
app.use("/downloads", express.static(DOWNLOADS));

function youtubeUrlOk(value) {
  try {
    if (!value || typeof value !== "string") return false;
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtu.be"
    ].includes(h);
  } catch {
    return false;
  }
}

function getCommonYtDlpArgs() {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--force-ipv4",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "--extractor-args",
    "youtube:player_client=ios,android,web,mweb;player_skip=webpage,configs"
  ];

  if (ffmpegPath) {
    args.push("--ffmpeg-location", ffmpegPath);
  }

  // Check for cookies file (cookies.txt in root or bin, or COOKIES_FILE env, or YOUTUBE_COOKIES env)
  const rootCookies = path.join(ROOT, "cookies.txt");
  const binCookies = path.join(ROOT, "bin", "cookies.txt");
  const customCookies = process.env.COOKIES_FILE || process.env.YOUTUBE_COOKIES_FILE;

  if (customCookies && fs.existsSync(customCookies)) {
    args.push("--cookies", customCookies);
  } else if (fs.existsSync(rootCookies)) {
    args.push("--cookies", rootCookies);
  } else if (fs.existsSync(binCookies)) {
    args.push("--cookies", binCookies);
  } else if (process.env.YOUTUBE_COOKIES) {
    // If passed directly as raw string, write to a temp cookie file
    try {
      const tempCookiePath = path.join(ROOT, "downloads", "temp_cookies.txt");
      fs.writeFileSync(tempCookiePath, process.env.YOUTUBE_COOKIES, "utf8");
      args.push("--cookies", tempCookiePath);
    } catch {}
  }

  // Check for Proxy configuration
  const proxy = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxy) {
    args.push("--proxy", proxy);
  }

  return args;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(err || out || `Process exited with code ${code}`));
    });
  });
}

// Background cleanup routine to prevent Hostinger disk space from filling up
function cleanOldFiles() {
  const maxAgeMs = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();

  [DOWNLOADS, UPLOADS].forEach((dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file === ".gitkeep" || file === "temp_cookies.txt") continue;
        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && (now - stats.mtimeMs) > maxAgeMs) {
            fs.unlinkSync(filePath);
          }
        } catch {}
      }
    } catch {}
  });
}

// Run cleanup every 10 minutes
setInterval(cleanOldFiles, 10 * 60 * 1000);

// Health check endpoint
app.get("/api/health", async (req, res) => {
  let ytdlpOk = false;
  let ytdlpVersion = "";
  try {
    const bin = await getYtDlp();
    const v = await run(bin, ["--version"]);
    ytdlpOk = true;
    ytdlpVersion = v.out.trim();
  } catch (e) {
    ytdlpVersion = e.message;
  }

  res.json({
    ok: true,
    status: "online",
    platform: process.platform,
    nodeVersion: process.version,
    ytDlp: {
      ready: ytdlpOk,
      path: activeYtDlpPath,
      version: ytdlpVersion
    },
    ffmpeg: {
      ready: !!ffmpegPath,
      path: ffmpegPath
    }
  });
});

app.post("/api/info", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!youtubeUrlOk(url)) {
      return res.status(400).json({ error: "Enter a valid YouTube URL." });
    }

    const ytDlp = await getYtDlp();
    const args = [
      ...getCommonYtDlpArgs(),
      "--dump-single-json",
      "--skip-download",
      url
    ];

    const r = await run(ytDlp, args);
    const data = JSON.parse(r.out);
    res.json({
      ok: true,
      title: data.title || "YouTube video",
      duration: data.duration || 0,
      thumbnail: data.thumbnail || ""
    });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

app.post("/api/download", async (req, res) => {
  try {
    const { url, format } = req.body || {};
    if (!youtubeUrlOk(url)) {
      return res.status(400).json({ error: "Enter a valid YouTube URL." });
    }
    if (!["mp3", "mp4"].includes(format)) {
      return res.status(400).json({ error: "Choose MP3 or MP4 format." });
    }

    const ytDlp = await getYtDlp();
    if (!ytDlp) {
      return res.status(500).json({ error: "yt-dlp is not ready yet. Please retry in a few seconds." });
    }

    const id = crypto.randomBytes(10).toString("hex");
    const titleTemplate = path.join(DOWNLOADS, `${id}.%(ext)s`);

    let args;
    if (format === "mp3") {
      args = [
        ...getCommonYtDlpArgs(),
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "-o", titleTemplate,
        url
      ];
    } else {
      args = [
        ...getCommonYtDlpArgs(),
        "-f", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", titleTemplate,
        url
      ];
    }

    await run(ytDlp, args);

    const files = fs.readdirSync(DOWNLOADS)
      .filter((f) => f.startsWith(id + ".") && !f.endsWith(".part") && !f.endsWith(".ytdl"));

    if (!files.length) {
      throw new Error("The file was not created by the downloader.");
    }
    const filename = files[0];

    res.json({
      ok: true,
      filename,
      downloadUrl: `/downloads/${encodeURIComponent(filename)}`
    });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

app.post("/api/cut", upload.single("media"), async (req, res) => {
  let inputPath = null, outputPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Choose an MP3 or MP4 file." });
    }
    if (!ffmpegPath) {
      return res.status(500).json({ error: "FFmpeg is missing on the server." });
    }

    const start = parseTime(req.body.start);
    const end = parseTime(req.body.end);
    if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
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
    await run(ffmpegPath, args);

    if (!fs.existsSync(outputPath)) {
      throw new Error("Cut file was not created.");
    }

    try { fs.unlinkSync(inputPath); } catch {}
    
    res.json({
      ok: true,
      filename: path.basename(outputPath),
      downloadUrl: `/downloads/${encodeURIComponent(path.basename(outputPath))}`
    });
  } catch (e) {
    if (inputPath && fs.existsSync(inputPath)) {
      try { fs.unlinkSync(inputPath); } catch {}
    }
    if (outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch {}
    }
    res.status(500).json({ error: friendlyError(e) });
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

function friendlyError(e) {
  const m = String(e.message || e);
  if (/Sign in to confirm|bot|cookies|429|Too Many Requests/i.test(m)) {
    return "YouTube requested bot verification for this live server IP. Add a cookies.txt file or configure a proxy in environment variables.";
  }
  if (/ffmpeg/i.test(m)) return "FFmpeg processing error. Ensure FFmpeg is installed.";
  if (/yt-dlp/i.test(m)) return "yt-dlp engine error. Please check the video URL or retry.";
  return m.slice(-800);
}

// Ensure binary is initialized on boot
getYtDlp().then((p) => {
  console.log(`[VidsSave] yt-dlp initialized at: ${p}`);
}).catch((err) => {
  console.warn(`[VidsSave] Warning during initial yt-dlp check:`, err.message);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("====================================");
  console.log("  VidsSave is running successfully");
  console.log(`  Port: ${PORT}`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log("====================================");
});

module.exports = app;
