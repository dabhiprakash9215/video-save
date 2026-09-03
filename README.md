# VidsSave - Production Ready

Full YouTube MP3/MP4 Downloader and Media Cutter with cross-platform support (Windows, Linux, Hostinger, Render, VPS).

---

## Features
- **YouTube to MP4** (Video + Audio combined)
- **YouTube to MP3** (Extracted high-quality audio)
- **Video Metadata Lookup** (Title, duration, thumbnail)
- **Media Cutter** (Cut MP3/MP4 by timestamps)
- **Cross-Platform Auto-Installer** (Automatically downloads and configures `yt-dlp` on Linux, macOS, and Windows)
- **Cloud & Live Server Anti-Bot Bypasses** (Client fallback extractors, IPv4 forcing, and custom cookie support)
- **Automated Storage Cleanup** (Deletes old temp files every 10 mins to preserve server disk space)
- **Live Health Diagnostics** at `/api/health`

---

## Local Run (Windows)
1. Install [Node.js 18+](https://nodejs.org/).
2. Double-click `START.bat`.
3. Opens automatically at `http://localhost:3000`.

---

## Deploying to Hostinger (VPS & Web/Cloud Hosting)
Full step-by-step instructions are available in [HOSTINGER_DEPLOY_GUIDE.md](file:///HOSTINGER_DEPLOY_GUIDE.md).

### Quick Hostinger VPS Setup:
```bash
# 1. Install Node.js 20 & FFmpeg
sudo apt update && sudo apt install -y nodejs npm ffmpeg
sudo npm install -g pm2

# 2. Upload code and install dependencies
npm install

# 3. Start with PM2
pm2 start ecosystem.config.js
```
