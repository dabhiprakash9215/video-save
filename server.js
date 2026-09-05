const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DOWNLOADS = path.join(ROOT, "downloads");
const UPLOADS = path.join(ROOT, "uploads");
const YTDLP = path.join(ROOT, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(path.dirname(YTDLP), { recursive: true });

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
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return ["youtube.com","www.youtube.com","m.youtube.com","youtu.be","www.youtu.be"].includes(h);
  } catch { return false; }
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

function safeExt(format) { return format === "mp3" ? "mp3" : "mp4"; }

app.get("/api/health", (req,res) => {
  res.json({
    ok: true,
    ytDlp: fs.existsSync(YTDLP),
    ffmpeg: !!ffmpeg
  });
});

app.post("/api/info", async (req,res) => {
  try {
    const { url } = req.body || {};
    if (!youtubeUrlOk(url)) return res.status(400).json({ error: "Enter a valid YouTube URL." });

    const r = await run(YTDLP, [
      "--no-playlist",
      "--dump-single-json",
      "--skip-download",
      "--no-warnings",
      url
    ]);
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

app.post("/api/download", async (req,res) => {
  try {
    const { url, format } = req.body || {};
    if (!youtubeUrlOk(url)) return res.status(400).json({ error: "Enter a valid YouTube URL." });
    if (!["mp3","mp4"].includes(format)) return res.status(400).json({ error: "Choose MP3 or MP4." });
    if (!fs.existsSync(YTDLP)) return res.status(500).json({ error: "yt-dlp is missing. Run START.bat once." });
    if (!ffmpeg) return res.status(500).json({ error: "FFmpeg is missing. Run npm install again." });

    const id = crypto.randomBytes(10).toString("hex");
    const titleTemplate = path.join(DOWNLOADS, `${id}.%(ext)s`);

    let args;
    if (format === "mp3") {
      args = [
        "--no-playlist",
        "--no-warnings",
        "--restrict-filenames",
        "--ffmpeg-location", ffmpeg,
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "-o", titleTemplate,
        url
      ];
    } else {
      args = [
        "--no-playlist",
        "--no-warnings",
        "--restrict-filenames",
        "--ffmpeg-location", ffmpeg,
        "-f", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", titleTemplate,
        url
      ];
    }

    await run(YTDLP, args);

    const files = fs.readdirSync(DOWNLOADS)
      .filter(f => f.startsWith(id + ".") && !f.endsWith(".part"));

    if (!files.length) throw new Error("The file was not created.");
    const filename = files[0];

    res.json({
      ok:true,
      filename,
      downloadUrl:`/downloads/${encodeURIComponent(filename)}`
    });
  } catch(e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

app.post("/api/cut", upload.single("media"), async (req,res) => {
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
    const outExt = [".mp3",".wav"].includes(ext) ? ext : ".mp4";
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

    fs.unlinkSync(inputPath);
    res.json({
      ok:true,
      filename:path.basename(outputPath),
      downloadUrl:`/downloads/${encodeURIComponent(path.basename(outputPath))}`
    });
  } catch(e) {
    if (inputPath && fs.existsSync(inputPath)) { try { fs.unlinkSync(inputPath); } catch {} }
    if (outputPath && fs.existsSync(outputPath)) { try { fs.unlinkSync(outputPath); } catch {} }
    res.status(500).json({ error: friendlyError(e) });
  }
});

function parseTime(v) {
  if (v === undefined || v === null || v === "") return NaN;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) return NaN;
  if (parts.length === 2) return parts[0]*60 + parts[1];
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  return NaN;
}

function friendlyError(e) {
  const m = String(e.message || e);
  if (/Sign in to confirm|bot|cookies/i.test(m)) {
    return "YouTube is asking for verification. Try another public video or use an authorized cookies setup.";
  }
  if (/ffmpeg/i.test(m)) return "FFmpeg error. Please run START.bat again so dependencies are installed.";
  if (/yt-dlp/i.test(m)) return "yt-dlp error. Run START.bat again to update/download yt-dlp.";
  return m.slice(-1800);
}

app.listen(PORT, () => {
  console.log("");
  console.log("====================================");
  console.log(" VidsSave is running");
  console.log(` http://localhost:${PORT}`);
  console.log("====================================");
});
