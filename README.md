# VidsSave Full Working

## Included
- YouTube URL -> MP4
- YouTube URL -> MP3
- Video title lookup
- Local MP3/MP4 cutter
- Node.js backend
- Automatic yt-dlp download on Windows
- Automatic FFmpeg installation through `ffmpeg-static`

## Easiest Windows setup

1. Install Node.js 18 or newer.
2. Extract this ZIP.
3. Double-click `START.bat`.
4. Wait for `npm install` to finish.
5. The browser opens at `http://localhost:3000`.

`START.bat` downloads the official yt-dlp Windows executable if it is missing. The official yt-dlp project provides release binaries for supported operating systems. FFmpeg is supplied through the `ffmpeg-static` npm package, whose Windows package includes a static FFmpeg binary.

## If Windows blocks START.bat
Right-click -> Properties -> if an Unblock checkbox appears, tick it -> Apply, then run it again.

## Manual run
```text
npm install
npm start
```

Then open:
http://localhost:3000

## Important
- A normal browser `index.html` cannot run the downloader by itself; the Node backend must be running.
- Downloads can fail for videos that require login, age verification, region restrictions, or anti-bot verification.
- Use the tool only for content you own or have permission to download.
- Do not expose this local server publicly without adding authentication, rate limits, storage cleanup, and other production security controls.

## Output folders
`downloads/` contains generated files.
`uploads/` temporarily contains cutter uploads.
