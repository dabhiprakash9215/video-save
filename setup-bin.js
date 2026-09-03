const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");

const ROOT = __dirname;
const BIN_DIR = path.join(ROOT, "bin");
const IS_WIN = process.platform === "win32";
const BIN_NAME = IS_WIN ? "yt-dlp.exe" : "yt-dlp";
const LOCAL_BIN_PATH = path.join(BIN_DIR, BIN_NAME);

function getEffectiveBinDir() {
  try {
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }
    const testFile = path.join(BIN_DIR, ".write_test");
    fs.writeFileSync(testFile, "1");
    fs.unlinkSync(testFile);
    return BIN_DIR;
  } catch {
    const tmpBin = path.join(os.tmpdir(), "vidssave_bin");
    if (!fs.existsSync(tmpBin)) {
      fs.mkdirSync(tmpBin, { recursive: true });
    }
    return tmpBin;
  }
}

function testBinary(binPath) {
  try {
    if (!fs.existsSync(binPath)) return false;
    if (!IS_WIN) {
      try { fs.chmodSync(binPath, 0o755); } catch {}
    }
    const out = execSync(`"${binPath}" --version`, {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 10000,
      encoding: "utf8"
    }).trim();
    return Boolean(out && out.length > 0);
  } catch {
    return false;
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const request = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download yt-dlp: HTTP ${res.statusCode}`));
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => {
        fileStream.close(() => {
          if (!IS_WIN) {
            try {
              fs.chmodSync(destPath, 0o755);
            } catch (err) {
              console.warn("[VidsSave] Warning setting execution permissions:", err.message);
            }
          }
          resolve(destPath);
        });
      });
      fileStream.on("error", (err) => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
    });

    request.on("error", (err) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function getDownloadUrl() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  } else if (platform === "darwin") {
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  } else {
    // Linux (Hostinger, Vercel, Ubuntu, Debian, CentOS, Alpine, etc.)
    // Note: yt-dlp_linux is the standalone binary that includes Python runtime
    // yt-dlp (generic) is a python script requiring python3 which is missing on Vercel/serverless
    if (arch === "arm64" || arch === "aarch64") {
      return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64";
    } else if (arch === "arm") {
      return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_armv7l";
    }
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  }
}

async function ensureYtDlp() {
  const targetDir = getEffectiveBinDir();
  const targetBinPath = path.join(targetDir, BIN_NAME);

  // 1. Check if bundled binary exists and works
  if (fs.existsSync(LOCAL_BIN_PATH) && testBinary(LOCAL_BIN_PATH)) {
    return LOCAL_BIN_PATH;
  }

  // 1b. If bundled exists in read-only folder, try copying to writable tmp dir and test
  if (fs.existsSync(LOCAL_BIN_PATH) && targetBinPath !== LOCAL_BIN_PATH) {
    try {
      fs.copyFileSync(LOCAL_BIN_PATH, targetBinPath);
      if (!IS_WIN) {
        try { fs.chmodSync(targetBinPath, 0o755); } catch {}
      }
      if (testBinary(targetBinPath)) {
        return targetBinPath;
      }
    } catch {}
  }

  // 1c. Check if targetBinPath already exists and works
  if (fs.existsSync(targetBinPath) && testBinary(targetBinPath)) {
    return targetBinPath;
  }

  // 2. Check if yt-dlp is available globally on system PATH
  try {
    const systemCmd = IS_WIN ? "where yt-dlp" : "which yt-dlp";
    const out = execSync(systemCmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out) {
      const firstPath = out.split(/\r?\n/)[0].trim();
      if (firstPath && testBinary(firstPath)) {
        console.log(`[VidsSave] Using system yt-dlp binary at: ${firstPath}`);
        return firstPath;
      }
    }
  } catch {}

  // 3. Auto-download the standalone binary
  const url = getDownloadUrl();
  console.log(`[VidsSave] Installing standalone yt-dlp binary for ${process.platform} (${process.arch})...`);
  console.log(`[VidsSave] Downloading from: ${url}`);
  
  await downloadFile(url, targetBinPath);

  if (!IS_WIN) {
    try { fs.chmodSync(targetBinPath, 0o755); } catch {}
  }

  if (testBinary(targetBinPath)) {
    console.log(`[VidsSave] Successfully installed standalone yt-dlp to: ${targetBinPath}`);
    return targetBinPath;
  } else {
    console.warn(`[VidsSave] Warning: Installed binary at ${targetBinPath} might have compatibility issues on this OS.`);
    return targetBinPath;
  }
}

if (require.main === module) {
  ensureYtDlp()
    .then((bin) => {
      console.log(`[VidsSave] Binary ready: ${bin}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[VidsSave] Failed to setup yt-dlp:", err.message);
      // Don't crash npm install if network fails during build; server.js will retry on start
      process.exit(0);
    });
}

module.exports = {
  ensureYtDlp,
  LOCAL_BIN_PATH,
  BIN_DIR
};
