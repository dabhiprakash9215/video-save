# Hostinger Deployment Guide for VidsSave

This guide explains how to deploy **VidsSave** on Hostinger so that video downloading and cutting work reliably in production without breaking.

---

## ⚠️ Why Video Downloaders Fail When Deployed Live (And How We Fixed It)

1. **Missing `yt-dlp` executable on Linux servers**: 
   - **Fix Applied**: `setup-bin.js` and `server.js` now automatically detect the host OS (Linux x64/aarch64, Windows, macOS) and auto-install the correct executable with executable permissions (`chmod 755`).
2. **YouTube Datacenter IP Bot Protection ("Sign in to confirm you're not a bot" / HTTP 429)**:
   - **Fix Applied**: Added `--extractor-args "youtube:player_client=ios,android,web,mweb;player_skip=webpage,configs"`, IPv4 routing (`--force-ipv4`), and real browser user-agent headers to bypass datacenter IP restrictions.
3. **Server Disk Space Full**:
   - **Fix Applied**: Added automatic background garbage collection that purges temporary downloads/uploads older than 30 minutes.

---

## Option 1: Deploy on Hostinger VPS (Recommended)

Hostinger VPS (Ubuntu/Debian) provides the best speed, full binary execution privileges, and unlimited process time.

### Step 1: Connect to your Hostinger VPS via SSH
```bash
ssh root@YOUR_SERVER_IP
```

### Step 2: Install Node.js (v18 or v20) and FFmpeg
```bash
# Update package list
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS & build tools
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg git

# Install PM2 process manager
sudo npm install -g pm2
```

### Step 3: Upload / Clone your Project
Upload the project files to `/var/www/vidssave` or clone from Git:
```bash
mkdir -p /var/www/vidssave
cd /var/www/vidssave
```

### Step 4: Install Dependencies & Setup Binaries
```bash
npm install
```
*(This will automatically download the Linux `yt-dlp` binary into `bin/` and apply `chmod +x`)*

### Step 5: Start the App with PM2
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Step 6: Configure Nginx (Reverse Proxy to Domain)
Create Nginx configuration `/etc/nginx/sites-available/vidssave`:
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
Enable the site & restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/vidssave /etc/nginx/sites-enabled/
sudo systemctl restart nginx
```

---

## Option 2: Deploy on Hostinger Web Hosting / Cloud Hosting (hPanel Node.js Selector)

If you are using Hostinger Cloud/Web Hosting with Node.js support in **hPanel**:

1. Open **Hostinger hPanel** -> Go to **Advanced** -> **Node.js**.
2. Click **Create Application**:
   - **Node.js Version**: Choose `18.x` or `20.x`
   - **Application Mode**: `Production`
   - **Application Root**: `vidssave` (or your folder name)
   - **Application Startup File**: `server.js`
3. Upload all project files into the folder via **File Manager** or Git.
4. Click **Run NPM Install** in hPanel.
5. In **Environment Variables** (optional):
   - Set `PORT` (or leave default assigned by Hostinger).
6. Click **Start / Restart Application**.

---

## 🔒 Optional: What If YouTube Blocks Your Specific Server IP?

If YouTube ever shows a bot challenge for a specific video on your live IP:
1. Export cookies from your browser using the Chrome extension **"Get cookies.txt LOCALLY"**.
2. Place the file as `cookies.txt` in the root folder of your project (same folder as `server.js`).
3. VidsSave will automatically detect and use `cookies.txt` on all requests!
