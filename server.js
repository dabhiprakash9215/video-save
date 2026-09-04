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
  const tmpDir = path.join(os.tmpdir(), "vidssave", sub);
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  return tmpDir;
}

const DOWNLOADS = resolveWritableDir("downloads");
const UPLOADS = resolveWritableDir("uploads");

// Resolve FFmpeg (ffmpeg-static or system ffmpeg)
let ffmpegPath = null;
try {
  let staticPath = require("ffmpeg-static");
  if (staticPath && fs.existsSync(staticPath)) {
    if (process.platform !== "win32") {
      try { fs.chmodSync(staticPath, 0o755); } catch { }
    }
    ffmpegPath = staticPath;
  }
} catch { }

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const out = execSync(cmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out) ffmpegPath = out.split(/\r?\n/)[0].trim();
  } catch { }
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

app.use(express.json({ limit: "5mb" }));
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use(express.static(path.join(ROOT, "public")));

// Deliver download file and auto-delete from temp storage after delivery
app.get("/downloads/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(DOWNLOADS, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found or download link expired." });
  }

  res.download(filePath, filename, (err) => {
    // Delete temporary file after client receives it
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch { }
    }, 2000);
  });
});

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

function resolveCookieFile(customCookieText) {
  // 1. If cookie text is supplied with request
  if (customCookieText && typeof customCookieText === "string" && customCookieText.trim().length > 10) {
    try {
      const cookieFileName = `req_cookie_${crypto.randomBytes(6).toString("hex")}.txt`;
      const cookieFilePath = path.join(DOWNLOADS, cookieFileName);
      fs.writeFileSync(cookieFilePath, customCookieText.trim(), "utf8");
      return { path: cookieFilePath, temporary: true };
    } catch { }
  }

  // 2. Custom file env
  const envFile = process.env.COOKIES_FILE || process.env.YOUTUBE_COOKIES_FILE;
  if (envFile && fs.existsSync(envFile)) {
    return { path: envFile, temporary: false };
  }

  // 3. Environment variable string or base64
  const envCookie = process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIES_BASE64;
  if (envCookie && typeof envCookie === "string" && envCookie.trim().length > 10) {
    try {
      let content = envCookie.trim();
      // Handle base64 encoded cookies
      if (!content.includes("\n") && !content.includes("\t") && content.length > 50) {
        try {
          const decoded = Buffer.from(content, "base64").toString("utf8");
          if (decoded.includes("youtube.com") || decoded.includes(".google.com")) {
            content = decoded;
          }
        } catch { }
      }
      const cookieFilePath = path.join(DOWNLOADS, "env_cookies.txt");
      fs.writeFileSync(cookieFilePath, content, "utf8");
      return { path: cookieFilePath, temporary: false };
    } catch { }
  }

  // 4. File in root or bin
  const rootCookies = path.join(ROOT, "cookies.txt");
  const binCookies = path.join(ROOT, "bin", "cookies.txt");
  if (fs.existsSync(rootCookies)) {
    return { path: rootCookies, temporary: false };
  }
  if (fs.existsSync(binCookies)) {
    return { path: binCookies, temporary: false };
  }

  return null;
}

function getCommonYtDlpArgs(cookieInfo = null) {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--force-ipv4",
    "--retries", "3",
    "--fragment-retries", "3",
    "--no-check-certificates",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "--extractor-args",
    "youtube:player_client=android_vr,web_creator,mweb,web,ios,android"
  ];

  if (ffmpegPath) {
    args.push("--ffmpeg-location", ffmpegPath);
  }

  if (cookieInfo && cookieInfo.path && fs.existsSync(cookieInfo.path)) {
    args.push("--cookies", cookieInfo.path);
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

// Background cleanup routine to prevent disk space from filling up
function cleanOldFiles() {
  const maxAgeMs = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  const dirsToClean = [
    DOWNLOADS,
    UPLOADS,
    path.join(ROOT, "downloads"),
    path.join(ROOT, "uploads")
  ];

  dirsToClean.forEach((dir) => {
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file === ".gitkeep" || file === "env_cookies.txt") continue;
        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && (now - stats.mtimeMs) > maxAgeMs) {
            fs.unlinkSync(filePath);
          }
        } catch { }
      }
    } catch { }
  });
}

// Run cleanup every 2 minutes
setInterval(cleanOldFiles, 2 * 60 * 1000);

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

  const cookieInfo = resolveCookieFile();

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
    },
    hasCookies: !!cookieInfo,
    isServerless: !!process.env.VERCEL
  });
});

app.post("/api/info", async (req, res) => {
  const { url, cookies: userCookies } = req.body || {};
  if (!youtubeUrlOk(url)) {
    return res.status(400).json({ error: "Enter a valid YouTube URL." });
  }

  // 1. First try official YouTube oEmbed API (instant, never blocked by bot check)
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(5000)
    });
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      return res.json({
        ok: true,
        title: oembed.title || "YouTube video",
        author: oembed.author_name || "",
        thumbnail: oembed.thumbnail_url || `https://i.ytimg.com/vi/${extractVideoId(url)}/hqdefault.jpg`,
        duration: 0
      });
    }
  } catch { }

  // 2. Fallback to yt-dlp metadata
  const cookieInfo = resolveCookieFile(userCookies);
  try {
    const ytDlp = await getYtDlp();
    const args = [
      ...getCommonYtDlpArgs(cookieInfo),
      "--dump-single-json",
      "--skip-download",
      url
    ];

    const r = await run(ytDlp, args);
    const data = JSON.parse(r.out);
    res.json({
      ok: true,
      title: data.title || "YouTube video",
      author: data.uploader || data.channel || "",
      duration: data.duration || 0,
      thumbnail: data.thumbnail || `https://i.ytimg.com/vi/${extractVideoId(url)}/hqdefault.jpg`
    });
  } catch (e) {
    // If yt-dlp fails but we can extract video ID, return basic info
    const vid = extractVideoId(url);
    if (vid) {
      return res.json({
        ok: true,
        title: "YouTube Video",
        author: "",
        duration: 0,
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`
      });
    }
    res.status(500).json({ error: friendlyError(e) });
  } finally {
    if (cookieInfo && cookieInfo.temporary && fs.existsSync(cookieInfo.path)) {
      try { fs.unlinkSync(cookieInfo.path); } catch { }
    }
  }
});

app.post("/api/download", async (req, res) => {
  const { url, format, quality, cookies: userCookies } = req.body || {};
  if (!youtubeUrlOk(url)) {
    return res.status(400).json({ error: "Enter a valid YouTube URL." });
  }
  if (!["mp3", "mp4"].includes(format)) {
    return res.status(400).json({ error: "Choose MP3 or MP4 format." });
  }

  const cookieInfo = resolveCookieFile(userCookies);

  try {
    const ytDlp = await getYtDlp();
    if (!ytDlp) {
      return res.status(500).json({ error: "Downloader binary is initializing. Please retry in a few seconds." });
    }

    const id = crypto.randomBytes(10).toString("hex");
    const titleTemplate = path.join(DOWNLOADS, `${id}.%(ext)s`);

    // Multi-client fallback strategy for downloading
    const clientAttempts = [
      "android_vr,web_creator,mweb,web",
      "android,ios,web",
      "web,mweb",
      ""
    ];

    let downloadSuccess = false;
    let lastError = null;

    for (const clientGroup of clientAttempts) {
      let baseArgs = [
        "--no-playlist",
        "--no-warnings",
        "--restrict-filenames",
        "--force-ipv4",
        "--retries", "3",
        "--fragment-retries", "3",
        "--no-check-certificates"
      ];

      if (clientGroup) {
        baseArgs.push("--extractor-args", `youtube:player_client=${clientGroup}`);
      }

      if (ffmpegPath) {
        baseArgs.push("--ffmpeg-location", ffmpegPath);
      }

      if (cookieInfo && cookieInfo.path && fs.existsSync(cookieInfo.path)) {
        baseArgs.push("--cookies", cookieInfo.path);
      }

      const proxy = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
      if (proxy) {
        baseArgs.push("--proxy", proxy);
      }

      let formatArgsList = [];

      if (format === "mp3") {
        if (ffmpegPath) {
          formatArgsList.push([
            "-f", "ba/b/bestaudio/best",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", quality === "320" ? "320K" : "192K",
            "-o", titleTemplate,
            url
          ]);
          // Fallback if strict audio selector fails
          formatArgsList.push([
            "-f", "best/bestaudio/b/ba",
            "-x",
            "--audio-format", "mp3",
            "-o", titleTemplate,
            url
          ]);
        } else {
          formatArgsList.push([
            "-f", "ba[ext=m4a]/140/ba/b/bestaudio/best",
            "-o", titleTemplate,
            url
          ]);
        }
      } else {
        // MP4 format
        if (quality === "1080" && ffmpegPath) {
          formatArgsList.push([
            "-f", "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b/best",
            "--merge-output-format", "mp4",
            "-o", titleTemplate,
            url
          ]);
        } else if (quality === "720" && ffmpegPath) {
          formatArgsList.push([
            "-f", "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b/best",
            "--merge-output-format", "mp4",
            "-o", titleTemplate,
            url
          ]);
        } else if (ffmpegPath) {
          // Standard / Best with FFmpeg
          formatArgsList.push([
            "-f", "bv*+ba/b/best",
            "--merge-output-format", "mp4",
            "-o", titleTemplate,
            url
          ]);
        } else {
          // No FFmpeg available
          formatArgsList.push([
            "-f", "b[ext=mp4]/18/22/b/best/bv*+ba",
            "-o", titleTemplate,
            url
          ]);
        }

        // Universal MP4 fallback
        if (ffmpegPath) {
          formatArgsList.push([
            "-f", "bestvideo*+bestaudio/best",
            "--merge-output-format", "mp4",
            "-o", titleTemplate,
            url
          ]);
        }
      }

      for (const fmtArgs of formatArgsList) {
        try {
          const runArgs = [...baseArgs, ...fmtArgs];
          await run(ytDlp, runArgs);
          downloadSuccess = true;
          break;
        } catch (err) {
          lastError = err;
          const errMsg = String(err.message || "");
          if (/bot|403|Forbidden|Sign in/i.test(errMsg)) {
            break;
          }
        }
      }

      if (downloadSuccess) break;
    }

    if (!downloadSuccess) {
      throw lastError || new Error("Failed to download video stream.");
    }

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
  } finally {
    if (cookieInfo && cookieInfo.temporary && fs.existsSync(cookieInfo.path)) {
      try { fs.unlinkSync(cookieInfo.path); } catch { }
    }
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

    try { fs.unlinkSync(inputPath); } catch { }

    res.json({
      ok: true,
      filename: path.basename(outputPath),
      downloadUrl: `/downloads/${encodeURIComponent(path.basename(outputPath))}`
    });
  } catch (e) {
    if (inputPath && fs.existsSync(inputPath)) {
      try { fs.unlinkSync(inputPath); } catch { }
    }
    if (outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch { }
    }
    res.status(500).json({ error: friendlyError(e) });
  }
});

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1).split("?")[0];
    }
    return u.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

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
  if (/Sign in to confirm you’re not a bot|Sign in to confirm you're not a bot|bot verification|HTTP Error 403: Forbidden|403.*Forbidden/i.test(m)) {
    return "YouTube requested bot verification for this server IP. To fix: Click '⚙️ Cookie Settings' in the header to paste YouTube cookies, or add YOUTUBE_COOKIES in your Vercel Environment Variables.";
  }
  if (/Requested format is not available/i.test(m)) {
    return "Selected video format is not directly available for this video. Please retry or choose a different format.";
  }
  if (/ffmpeg/i.test(m) && !/warning/i.test(m)) return "FFmpeg processing error. Ensure FFmpeg is available.";
  if (/yt-dlp/i.test(m) && /exited with code/i.test(m)) return "Download stream error. Please check the video URL and retry.";
  return m.slice(-600);
}

// Only start standalone HTTP server if not in Vercel Serverless environment
if (!process.env.VERCEL) {
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
}

module.exports = app;

