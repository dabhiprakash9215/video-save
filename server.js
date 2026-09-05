const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DOWNLOADS = path.join(ROOT, "downloads");
const UPLOADS = path.join(ROOT, "uploads");
const BIN_DIR = path.join(ROOT, "bin");
let YTDLP = path.join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

function ensureDirectories() {
  try {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });
  } catch (e) {
    console.error("[VidsSave] Error creating directories:", e.message);
  }
}
ensureDirectories();

const ffmpeg = require("ffmpeg-static");
const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/downloads", express.static(DOWNLOADS));

function youtubeUrlOk(value) {
  try {
    const u = new URL(String(value).trim());
    const h = u.hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"].includes(h);
  } catch {
    return false;
  }
}

function cleanYoutubeUrl(value) {
  try {
    const u = new URL(String(value).trim());
    if (u.hostname.includes("youtu.be")) {
      const vid = u.pathname.replace(/^\//, "").split("?")[0].split("&")[0];
      if (vid) return `https://www.youtube.com/watch?v=${vid}`;
    }
    if (u.hostname.includes("youtube.com")) {
      const vid = u.searchParams.get("v");
      if (vid) return `https://www.youtube.com/watch?v=${vid}`;
    }
  } catch {}
  return String(value).trim();
}

function downloadBinary(url, dest, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith("http")) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.origin}${redirectUrl}`;
        }
        res.resume();
        return resolve(downloadBinary(redirectUrl, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed with status: ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(dest);
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(() => resolve()));
      fileStream.on("error", (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    });
    req.on("error", (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

async function getOrInitYtDlp() {
  ensureDirectories();
  const isWin = process.platform === "win32";

  // 1. Check if bin file exists and is valid (> 1MB)
  if (fs.existsSync(YTDLP)) {
    try {
      const stats = fs.statSync(YTDLP);
      if (stats.size > 1000000) {
        if (!isWin) {
          try { fs.chmodSync(YTDLP, 0o755); } catch {}
        }
        return YTDLP;
      }
    } catch {}
  }

  // 2. Check if yt-dlp is available in system path
  try {
    const checkCmd = isWin ? "where yt-dlp" : "which yt-dlp";
    const found = execSync(checkCmd, { encoding: "utf8" }).trim().split("\n")[0].trim();
    if (found && fs.existsSync(found)) {
      console.log(`[VidsSave] Using system yt-dlp binary at: ${found}`);
      YTDLP = found;
      return YTDLP;
    }
  } catch {}

  // 3. Download binary automatically if missing
  console.log(`[VidsSave] yt-dlp binary not found. Downloading for ${process.platform}...`);
  const downloadUrl = isWin
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  if (!isWin) {
    try {
      execSync(`curl -L -s --retry 3 "${downloadUrl}" -o "${YTDLP}"`);
    } catch (e) {
      await downloadBinary(downloadUrl, YTDLP);
    }
    try { fs.chmodSync(YTDLP, 0o755); } catch {}
  } else {
    await downloadBinary(downloadUrl, YTDLP);
  }

  console.log(`[VidsSave] yt-dlp binary ready at: ${YTDLP}`);
  return YTDLP;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(err || `Process exited with code ${code}`));
    });
  });
}

// Helper to run yt-dlp with automatic player_client rotation to bypass datacenter blocks
async function runYtDlp(bin, baseArgs, targetUrl) {
  const clientProfiles = [
    ["--extractor-args", "youtube:player_client=android,web"],
    ["--extractor-args", "youtube:player_client=ios,mweb"],
    ["--extractor-args", "youtube:player_client=web,mweb,android,ios"],
    [] // default fallback
  ];

  let lastError = null;
  for (const clientArgs of clientProfiles) {
    try {
      const fullArgs = [
        "--no-playlist",
        "--no-warnings",
        "--no-check-certificates",
        "--geo-bypass",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...clientArgs,
        ...baseArgs,
        targetUrl
      ];
      return await run(bin, fullArgs);
    } catch (err) {
      lastError = err;
      const msg = String(err.message || err);
      // If error is specific to player response extraction, try next profile
      if (/player response|extract|bot|sign in/i.test(msg)) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

app.get("/api/health", async (req, res) => {
  let ytOk = false;
  try {
    const binPath = await getOrInitYtDlp();
    ytOk = fs.existsSync(binPath);
  } catch {}
  res.json({
    ok: true,
    ytDlp: ytOk,
    ffmpeg: !!ffmpeg,
    platform: process.platform
  });
});

app.post("/api/info", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!youtubeUrlOk(url)) return res.status(400).json({ error: "Enter a valid YouTube URL." });

    const cleanUrl = cleanYoutubeUrl(url);
    const bin = await getOrInitYtDlp();

    const r = await runYtDlp(bin, [
      "--dump-single-json",
      "--skip-download"
    ], cleanUrl);

    const data = JSON.parse(r.out);
    res.json({
      ok: true,
      title: data.title || "YouTube video",
      duration: data.duration || 0,
      thumbnail: data.thumbnail || ""
    });
  } catch (e) {
    console.error("[/api/info error]", e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

app.post("/api/download", async (req, res) => {
  try {
    ensureDirectories();
    const { url, format } = req.body || {};
    if (!youtubeUrlOk(url)) return res.status(400).json({ error: "Enter a valid YouTube URL." });
    if (!["mp3", "mp4"].includes(format)) return res.status(400).json({ error: "Choose MP3 or MP4." });

    const cleanUrl = cleanYoutubeUrl(url);
    const bin = await getOrInitYtDlp();
    if (!ffmpeg) return res.status(500).json({ error: "FFmpeg is missing. Please restart the service." });

    const id = crypto.randomBytes(10).toString("hex");
    const titleTemplate = path.join(DOWNLOADS, `${id}.%(ext)s`);

    let formatArgs;
    if (format === "mp3") {
      formatArgs = [
        "--restrict-filenames",
        "--ffmpeg-location", ffmpeg,
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "-o", titleTemplate
      ];
    } else {
      formatArgs = [
        "--restrict-filenames",
        "--ffmpeg-location", ffmpeg,
        "-f", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", titleTemplate
      ];
    }

    await runYtDlp(bin, formatArgs, cleanUrl);

    const files = fs.readdirSync(DOWNLOADS)
      .filter(f => f.startsWith(id + ".") && !f.endsWith(".part"));

    if (!files.length) throw new Error("The file was not created.");
    const filename = files[0];

    res.json({
      ok: true,
      filename,
      downloadUrl: `/downloads/${encodeURIComponent(filename)}`
    });
  } catch (e) {
    console.error("[/api/download error]", e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

app.post("/api/cut", upload.single("media"), async (req, res) => {
  let inputPath = null, outputPath = null;
  try {
    ensureDirectories();
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
    await run(ffmpeg, args);

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
  if (/Sign in to confirm|bot|cookies/i.test(m)) {
    return "YouTube is asking for bot/verification. Try another public video link.";
  }
  if (/ffmpeg/i.test(m)) return "FFmpeg conversion error. Please try again.";
  if (/yt-dlp.*(not found|missing|ENOENT|EACCES)/i.test(m)) {
    return "Downloader binary is initializing on the server. Please wait 10 seconds and try again.";
  }
  return m.slice(-1800);
}

// Auto-delete temporary files older than 10 minutes to save disk space
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

// Initialize binary and start server
getOrInitYtDlp().catch(err => console.warn("[Startup] Binary init note:", err.message));

app.listen(PORT, "0.0.0.0", () => {
  console.log("====================================");
  console.log(" VidsSave is running");
  console.log(` http://0.0.0.0:${PORT}`);
  console.log("====================================");
});
