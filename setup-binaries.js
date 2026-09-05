const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");

const binDir = path.join(__dirname, "bin");
fs.mkdirSync(binDir, { recursive: true });

const isWin = process.platform === "win32";
const targetFilename = isWin ? "yt-dlp.exe" : "yt-dlp";
const targetPath = path.join(binDir, targetFilename);

const downloadUrl = isWin
  ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

function downloadFile(url, dest, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error("Too many redirects while downloading binary"));
  }

  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith("http")) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.origin}${redirectUrl}`;
        }
        res.resume();
        return resolve(downloadFile(redirectUrl, dest, redirects + 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Failed to download binary: HTTP ${res.statusCode}`));
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
    });

    req.on("error", (err) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

async function main() {
  try {
    // Check if valid binary already exists
    if (fs.existsSync(targetPath)) {
      const stats = fs.statSync(targetPath);
      if (stats.size > 1000000) {
        console.log(`[setup-binaries] yt-dlp binary already exists (${stats.size} bytes): ${targetPath}`);
        if (!isWin) {
          try { fs.chmodSync(targetPath, 0o755); } catch {}
        }
        return;
      }
    }

    console.log(`[setup-binaries] Downloading yt-dlp for ${process.platform}...`);
    
    // Try curl first if available (standard in Linux/Render environments)
    let downloadedViaCurl = false;
    if (!isWin) {
      try {
        execSync(`curl -L -s --retry 3 "${downloadUrl}" -o "${targetPath}"`, { stdio: "inherit" });
        if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000000) {
          downloadedViaCurl = true;
          console.log(`[setup-binaries] yt-dlp downloaded via curl.`);
        }
      } catch (curlErr) {
        console.warn(`[setup-binaries] curl fallback to Node https...`);
      }
    }

    if (!downloadedViaCurl) {
      await downloadFile(downloadUrl, targetPath);
      console.log(`[setup-binaries] yt-dlp binary downloaded via https: ${targetPath}`);
    }

    if (!isWin) {
      try {
        fs.chmodSync(targetPath, 0o755);
        console.log(`[setup-binaries] Permissions 755 set on ${targetPath}`);
      } catch (chmodErr) {
        try { execSync(`chmod +x "${targetPath}"`); } catch {}
      }
    }
  } catch (err) {
    console.error("[setup-binaries] Setup failed:", err.message);
    // Don't crash build, server.js will also attempt runtime auto-recovery
  }
}

if (require.main === module) {
  main();
}

module.exports = { downloadFile, main };
