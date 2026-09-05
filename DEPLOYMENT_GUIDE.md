# VidsSave - Production Deployment & Architecture Guide

## 1. Architecture Overview

This media downloader application is architected into two cleanly decoupled layers:

```
┌─────────────────────────────────────────────────────────┐
│              FRONTEND LAYER (Vercel / CDN)              │
│  - Next.js / Static UI (HTML5, Tailwind, Vanilla JS)    │
│  - Configured with NEXT_PUBLIC_DOWNLOAD_API_URL         │
│  - Zero cookies stored in browser (localStorage removed)│
└────────────────────────────┬────────────────────────────┘
                             │  REST API (CORS enabled)
                             ▼
┌─────────────────────────────────────────────────────────┐
│        DEDICATED DOWNLOAD BACKEND (Node.js VPS)         │
│  - Long-running Persistent Node.js HTTP Server          │
│  - Asynchronous In-Memory Job Queue & Worker Pool       │
│  - yt-dlp & FFmpeg execution via spawn argument arrays  │
│  - Server-side YouTube Auth via YOUTUBE_COOKIES env var │
│  - Streaming file delivery & Auto-cleanup engine        │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Environment Variables

### Backend Environment Variables (`.env` on Dedicated Server)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the Node.js backend to listen on. |
| `HOST` | `0.0.0.0` | Network binding interface. |
| `CORS_ORIGIN` | `*` | Allowed origin for frontend requests (e.g. `https://your-frontend.vercel.app`). |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Maximum simultaneous active yt-dlp download processes. |
| `JOB_TIMEOUT_MS` | `300000` | Download timeout in milliseconds (default: 5 minutes). |
| `FILE_TTL_MS` | `600000` | File retention time on disk before auto-deletion (default: 10 minutes). |
| `YTDLP_PATH` | *(auto-detected)* | Custom path to `yt-dlp` executable if not in system PATH. |
| `FFMPEG_PATH` | *(auto-detected)* | Custom path to `ffmpeg` executable if not in system PATH. |
| `YOUTUBE_COOKIES` | *(optional)* | Raw Netscape cookie string for authenticated downloads. |
| `YOUTUBE_COOKIES_BASE64`| *(optional)* | Base64-encoded Netscape cookie string for authenticated downloads. |
| `YOUTUBE_COOKIES_FILE` | *(optional)* | Absolute filesystem path to a secure `cookies.txt` file on the server. |
| `YT_EXTRACTOR_ARGS` | *(optional)* | Custom extractor args for yt-dlp (e.g., `youtube:player_client=android,web`). |
| `USER_AGENT` | *(optional)* | Custom User-Agent string for yt-dlp HTTP requests. |
| `PROXY_URL` | *(optional)* | Optional HTTP/SOCKS proxy for yt-dlp (e.g., `socks5://127.0.0.1:9050`). |

### Frontend Environment Variables (Vercel)

| Variable | Example Value | Description |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_DOWNLOAD_API_URL` | `https://api.yourdomain.com` | Full HTTPS URL pointing to the dedicated Node.js backend. |

---

## 3. Dedicated Backend Setup (Ubuntu / Debian VPS)

### Step 3.1: Install System Dependencies
```bash
# Update package lists
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+ or 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install FFmpeg & Python
sudo apt install -y ffmpeg python3 python3-pip

# Install latest yt-dlp binary
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

### Step 3.2: Clone and Install Application
```bash
git clone https://github.com/your-repo/video-save.git /var/www/vidssave-backend
cd /var/www/vidssave-backend
npm ci --production
```

### Step 3.3: Verify System Binaries
```bash
node -e "require('./test/test-suite.js').runTestSuite()"
```

### Step 3.4: Configure Process Manager (PM2)
```bash
sudo npm install -g pm2

# Start service using ecosystem config
pm2 start ecosystem.config.js --env production

# Setup startup on system reboot
pm2 save
pm2 startup
```

---

## 4. Nginx Reverse Proxy with SSL / HTTPS

Create an Nginx configuration file: `/etc/nginx/sites-available/vidssave-api`

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    # Redirect all HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    client_max_body_size 500M;
    proxy_read_timeout 600s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
    }
}
```

Enable site & obtain SSL certificate:
```bash
sudo ln -s /etc/nginx/sites-available/vidssave-api /etc/nginx/sites-enabled/
sudo certbot --nginx -d api.yourdomain.com
sudo nginx -t
sudo systemctl reload nginx
```

---

## 5. Frontend Deployment (Vercel)

1. Connect your GitHub repository to **Vercel**.
2. Set the Project Root directory to the frontend directory.
3. In **Settings > Environment Variables**, add:
   - **Key**: `NEXT_PUBLIC_DOWNLOAD_API_URL`
   - **Value**: `https://api.yourdomain.com`
4. Deploy the frontend.

---

## 6. Server-Side YouTube Cookies Configuration

When YouTube datacenter IP verification is triggered:

1. Log into YouTube in an isolated browser profile.
2. Export your cookies in **Netscape format** using the extension *Get cookies.txt LOCALLY*.
3. Add the exported cookie text to your backend environment on the dedicated server:
   ```bash
   # In .env file on backend server:
   YOUTUBE_COOKIES="# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\t..."
   ```
   *Alternatively, pass base64 or a secure file path:*
   ```bash
   YOUTUBE_COOKIES_FILE="/etc/vidssave/cookies.txt"
   ```
4. Restart PM2:
   ```bash
   pm2 restart vidssave-backend
   ```
5. **Security Guarantee**:
   - The backend reads cookies strictly from server-side environment variables.
   - The cookie file is generated in an isolated temporary location with restricted permissions (`0o600`).
   - Cookies are never exposed in logs, HTTP responses, or sent to the frontend.

---

## 7. API Endpoints Reference

### `GET /health`
Verifies backend status, Node version, yt-dlp version, FFmpeg presence, disk writability, and queue load.

### `POST /api/info`
Fast video metadata extraction (Title, Channel, Thumbnail, Duration).
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

### `POST /api/download`
Creates an asynchronous download job.
```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "format": "mp4",
  "quality": "1080"
}
```
**Response (`202 Accepted`):**
```json
{
  "success": true,
  "jobId": "8f3b2a19c4d8e7",
  "status": "queued",
  "message": "Download job queued successfully."
}
```

### `GET /api/download/:jobId`
Polls job progress and state (`queued` -> `downloading` -> `transcoding` -> `completed` / `failed`).

### `GET /api/download/:jobId/file`
Directly streams the finalized media file with `Content-Disposition: attachment` and triggers automatic temporary file deletion after delivery.

### `POST /api/cut`
Trims local audio/video file between start and end timestamps using server FFmpeg.
