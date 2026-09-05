"use strict";

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ensureYtDlp } = require("../../setup-bin");
const { resolveServerCookie, cleanupCookie } = require("../utils/cookie-manager");
const { extractVideoId } = require("../utils/validator");
const { mapError } = require("../utils/error-mapper");

// Directory resolution
function resolveDirectory(name) {
  const dir = path.join(os.tmpdir(), "vidssave", name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  return dir;
}

const DOWNLOAD_DIR = resolveDirectory("downloads");
const TEMP_DIR = resolveDirectory("temp");

// FFmpeg Resolution
let cachedFfmpegPath = null;
function getFfmpegPath() {
  if (cachedFfmpegPath && fs.existsSync(cachedFfmpegPath)) {
    return cachedFfmpegPath;
  }

  // 1. Env variable
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    cachedFfmpegPath = process.env.FFMPEG_PATH;
    return cachedFfmpegPath;
  }

  // 2. ffmpeg-static package
  try {
    const staticPath = require("ffmpeg-static");
    if (staticPath && fs.existsSync(staticPath)) {
      if (process.platform !== "win32") {
        try { fs.chmodSync(staticPath, 0o755); } catch { }
      }
      cachedFfmpegPath = staticPath;
      return cachedFfmpegPath;
    }
  } catch { }

  // 3. System PATH
  try {
    const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const out = execSync(cmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out) {
      const first = out.split(/\r?\n/)[0].trim();
      if (fs.existsSync(first)) {
        cachedFfmpegPath = first;
        return cachedFfmpegPath;
      }
    }
  } catch { }

  return null;
}

// yt-dlp Resolution
let cachedYtDlpPath = null;
async function getYtDlpPath() {
  if (cachedYtDlpPath && fs.existsSync(cachedYtDlpPath)) {
    return cachedYtDlpPath;
  }

  // 1. Env variable
  if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) {
    cachedYtDlpPath = process.env.YTDLP_PATH;
    return cachedYtDlpPath;
  }

  // 2. Local setup-bin resolution
  cachedYtDlpPath = await ensureYtDlp();
  return cachedYtDlpPath;
}

/**
 * Execute command with safe argument arrays
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function execSafe(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      windowsHide: true,
      ...options
    });

    let stdout = "";
    let stderr = "";

    if (proc.stdout) {
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (options.onStdout) options.onStdout(chunk.toString());
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (options.onStderr) options.onStderr(chunk.toString());
      });
    }

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(stderr || stdout || `Process exited with code ${code}`);
        error.code = code;
        reject(error);
      }
    });

    if (options.registerProcess) {
      options.registerProcess(proc);
    }
  });
}

/**
 * Get system diagnostics without leaking sensitive data
 */
async function getDiagnostics() {
  let ytDlpOk = false;
  let ytDlpVersion = "Unavailable";
  let ffmpegOk = false;
  let ffmpegVersion = "Unavailable";

  try {
    const ytPath = await getYtDlpPath();
    if (ytPath) {
      const res = await execSafe(ytPath, ["--version"]);
      ytDlpVersion = res.stdout.trim();
      ytDlpOk = true;
    }
  } catch (err) {
    ytDlpVersion = `Error: ${err.message}`;
  }

  const fPath = getFfmpegPath();
  if (fPath) {
    try {
      const res = await execSafe(fPath, ["-version"]);
      const firstLine = res.stdout.split(/\r?\n/)[0] || "";
      ffmpegVersion = firstLine.trim();
      ffmpegOk = true;
    } catch (err) {
      ffmpegVersion = `Error: ${err.message}`;
    }
  }

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    ytDlp: {
      available: ytDlpOk,
      version: ytDlpVersion
    },
    ffmpeg: {
      available: ffmpegOk,
      version: ffmpegVersion
    },
    directories: {
      downloadsWritable: fs.existsSync(DOWNLOAD_DIR),
      tempWritable: fs.existsSync(TEMP_DIR)
    }
  };
}

/**
 * Fetch video metadata
 * @param {string} url
 * @returns {Promise<{ title: string, author: string, thumbnail: string, duration: number }>}
 */
async function fetchMetadata(url) {
  const vidId = extractVideoId(url);

  // 1. Try oEmbed fast path
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const json = await res.json();
      return {
        title: json.title || "YouTube Video",
        author: json.author_name || "",
        thumbnail: json.thumbnail_url || (vidId ? `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg` : ""),
        duration: 0
      };
    }
  } catch { }

  // 2. yt-dlp metadata extraction
  const ytDlp = await getYtDlpPath();
  if (!ytDlp) {
    throw new Error("YTDLP_NOT_FOUND");
  }

  const cookieInfo = resolveServerCookie();
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    "--dump-single-json"
  ];

  if (cookieInfo && cookieInfo.path) {
    args.push("--cookies", cookieInfo.path);
  }

  const userAgent = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  args.push("--user-agent", userAgent);

  const extractorArgs = process.env.YT_EXTRACTOR_ARGS;
  if (extractorArgs) {
    args.push("--extractor-args", extractorArgs);
  }

  const proxy = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxy) {
    args.push("--proxy", proxy);
  }

  args.push(url);

  try {
    const { stdout } = await execSafe(ytDlp, args);
    const data = JSON.parse(stdout);
    return {
      title: data.title || "YouTube Video",
      author: data.uploader || data.channel || "",
      thumbnail: data.thumbnail || (vidId ? `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg` : ""),
      duration: data.duration || 0
    };
  } catch (err) {
    if (vidId) {
      return {
        title: "YouTube Video",
        author: "",
        thumbnail: `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`,
        duration: 0
      };
    }
    throw err;
  } finally {
    cleanupCookie(cookieInfo);
  }
}

/**
 * Execute media download
 * @param {object} job
 * @param {function} onProgress
 * @param {function} registerProcess
 * @returns {Promise<{ filePath: string, filename: string, fileSize: number }>}
 */
async function executeDownload(job, onProgress, registerProcess) {
  const ytDlp = await getYtDlpPath();
  if (!ytDlp) {
    throw new Error("YTDLP_NOT_FOUND");
  }

  const ffmpeg = getFfmpegPath();
  const cookieInfo = resolveServerCookie();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${job.id}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--newline",
    "--progress",
    "--force-ipv4",
    "--retries", "3",
    "--fragment-retries", "3"
  ];

  if (ffmpeg) {
    args.push("--ffmpeg-location", ffmpeg);
  }

  if (cookieInfo && cookieInfo.path) {
    args.push("--cookies", cookieInfo.path);
  }

  const userAgent = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  args.push("--user-agent", userAgent);

  const extractorArgs = process.env.YT_EXTRACTOR_ARGS;
  if (extractorArgs) {
    args.push("--extractor-args", extractorArgs);
  }

  const proxy = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxy) {
    args.push("--proxy", proxy);
  }

  // Format selection
  if (job.format === "mp3") {
    if (ffmpeg) {
      const bitrate = job.quality === "320" ? "320K" : job.quality === "128" ? "128K" : "192K";
      args.push(
        "-f", "ba/b/bestaudio/best",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", bitrate
      );
    } else {
      args.push("-f", "ba[ext=m4a]/140/ba/b/bestaudio/best");
    }
  } else {
    // MP4 Video
    if (job.quality === "1080" && ffmpeg) {
      args.push("-f", "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b/best", "--merge-output-format", "mp4");
    } else if (job.quality === "720" && ffmpeg) {
      args.push("-f", "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b/best", "--merge-output-format", "mp4");
    } else if (job.quality === "480" && ffmpeg) {
      args.push("-f", "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b/best", "--merge-output-format", "mp4");
    } else if (job.quality === "360" && ffmpeg) {
      args.push("-f", "bv*[height<=360]+ba/b[height<=360]/bv*+ba/b/best", "--merge-output-format", "mp4");
    } else if (ffmpeg) {
      args.push("-f", "bv*+ba/b/best", "--merge-output-format", "mp4");
    } else {
      args.push("-f", "b[ext=mp4]/18/22/b/best/bv*+ba");
    }
  }

  args.push("-o", outputTemplate, job.url);

  // Progress parser
  function handleProgressOutput(text) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      // Example: [download]  45.2% of ~ 15.20MiB at  2.50MiB/s ETA 00:03
      const match = line.match(/\[download\]\s+([\d.]+)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        if (!isNaN(percent)) {
          onProgress({ progress: Math.min(percent, 99), stage: "downloading" });
        }
      } else if (line.includes("[ExtractAudio]") || line.includes("[Merger]")) {
        if (onProgress) {
          onProgress({ progress: 95, stage: "transcoding" });
        }
      }
    }
  }

  try {
    await execSafe(ytDlp, args, {
      onStdout: handleProgressOutput,
      onStderr: handleProgressOutput,
      registerProcess
    });

    // Locate the created output file
    const files = fs.readdirSync(DOWNLOAD_DIR)
      .filter((f) => f.startsWith(job.id + ".") && !f.endsWith(".part") && !f.endsWith(".ytdl"));

    if (!files.length) {
      throw new Error("The media file was not generated by yt-dlp.");
    }

    const filename = files[0];
    const filePath = path.join(DOWNLOAD_DIR, filename);
    const stats = fs.statSync(filePath);

    return {
      filePath,
      filename,
      fileSize: stats.size
    };
  } finally {
    cleanupCookie(cookieInfo);
  }
}

/**
 * Trim media file using FFmpeg
 * @param {string} inputPath
 * @param {number} start
 * @param {number} end
 * @param {string} originalName
 * @returns {Promise<{ filePath: string, filename: string }>}
 */
async function trimMedia(inputPath, start, end, originalName) {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) {
    throw new Error("FFMPEG_NOT_FOUND");
  }

  const ext = path.extname(originalName).toLowerCase() || ".mp4";
  const isAudio = [".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext);
  const outExt = isAudio ? ".mp3" : ".mp4";
  const id = require("crypto").randomBytes(10).toString("hex");
  const filename = `trimmed_${id}${outExt}`;
  const outputPath = path.join(DOWNLOAD_DIR, filename);

  const duration = end - start;
  const args = [
    "-y",
    "-ss", String(start),
    "-i", inputPath,
    "-t", String(duration)
  ];

  if (outExt === ".mp3") {
    args.push("-vn", "-c:a", "libmp3lame", "-b:a", "192k");
  } else {
    args.push("-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart");
  }

  args.push(outputPath);

  await execSafe(ffmpeg, args);

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to create trimmed media file.");
  }

  return { filePath: outputPath, filename };
}

module.exports = {
  getDiagnostics,
  fetchMetadata,
  executeDownload,
  trimMedia,
  DOWNLOAD_DIR,
  TEMP_DIR,
  getYtDlpPath,
  getFfmpegPath
};
