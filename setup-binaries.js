const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const binDir = path.join(__dirname, "bin");
fs.mkdirSync(binDir, { recursive: true });

const isWin = process.platform === "win32";
const targetFilename = isWin ? "yt-dlp.exe" : "yt-dlp";
const targetPath = path.join(binDir, targetFilename);

const downloadUrl = isWin
  ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects (GitHub releases redirect to AWS S3/objects)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, dest));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download binary: HTTP status ${res.statusCode}`));
      }

      const fileStream = fs.createWriteStream(dest);
      res.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close(() => resolve());
      });

      fileStream.on("error", (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    }).on("error", reject);
  });
}

async function main() {
  try {
    if (!fs.existsSync(targetPath)) {
      console.log(`[setup-binaries] Downloading yt-dlp for ${process.platform}...`);
      await downloadFile(downloadUrl, targetPath);
      console.log(`[setup-binaries] yt-dlp binary downloaded successfully: ${targetPath}`);
    } else {
      console.log(`[setup-binaries] yt-dlp binary already exists: ${targetPath}`);
    }

    if (!isWin) {
      try {
        execSync(`chmod +x "${targetPath}"`);
        console.log(`[setup-binaries] Executable permissions applied to ${targetPath}`);
      } catch (err) {
        console.warn(`[setup-binaries] Warning: Could not chmod yt-dlp binary:`, err.message);
      }
    }
  } catch (err) {
    console.error("[setup-binaries] Setup failed:", err.message);
    process.exit(1);
  }
}

main();
