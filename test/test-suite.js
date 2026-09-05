"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const {
  isValidYouTubeUrl,
  extractVideoId,
  validateFormat,
  validateQuality,
  parseTimestamp
} = require("../src/utils/validator");
const { mapError, ERROR_CODES } = require("../src/utils/error-mapper");
const {
  resolveServerCookie,
  cleanupCookie,
  isValidNetscapeCookie
} = require("../src/utils/cookie-manager");
const { getDiagnostics, getYtDlpPath, getFfmpegPath } = require("../src/services/downloader");
const jobManager = require("../src/services/job-manager");

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}:`, err.message);
    failed++;
  }
}

async function asyncIt(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}:`, err.message);
    failed++;
  }
}

async function runTestSuite() {
  console.log("\n=======================================================");
  console.log("    RUNNING VIDSSAVE TEST SUITE");
  console.log("=======================================================\n");

  console.log("1. URL Validator Tests:");
  it("Accepts standard youtube.com watch URLs", () => {
    assert.strictEqual(isValidYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
    assert.strictEqual(isValidYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ"), true);
    assert.strictEqual(isValidYouTubeUrl("http://m.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  });

  it("Accepts youtu.be short URLs", () => {
    assert.strictEqual(isValidYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), true);
    assert.strictEqual(isValidYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=42"), true);
  });

  it("Accepts YouTube shorts, live and music URLs", () => {
    assert.strictEqual(isValidYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), true);
    assert.strictEqual(isValidYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ"), true);
    assert.strictEqual(isValidYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), true);
  });

  it("Rejects non-YouTube and malicious URLs", () => {
    assert.strictEqual(isValidYouTubeUrl("https://vimeo.com/123456"), false);
    assert.strictEqual(isValidYouTubeUrl("https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ"), false);
    assert.strictEqual(isValidYouTubeUrl("javascript:alert(1)"), false);
    assert.strictEqual(isValidYouTubeUrl("http://localhost:3000"), false);
    assert.strictEqual(isValidYouTubeUrl("https://www.youtube.com/watch?v=invalid;rm -rf /"), false);
    assert.strictEqual(isValidYouTubeUrl(""), false);
    assert.strictEqual(isValidYouTubeUrl(null), false);
  });

  it("Extracts clean 11-char video ID", () => {
    assert.strictEqual(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.strictEqual(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=123"), "dQw4w9WgXcQ");
    assert.strictEqual(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.strictEqual(extractVideoId("invalid"), null);
  });

  it("Validates format and quality defaults", () => {
    assert.strictEqual(validateFormat("mp3"), "mp3");
    assert.strictEqual(validateFormat("MP4"), "mp4");
    assert.strictEqual(validateFormat("avi"), "mp4");
    assert.strictEqual(validateQuality("720"), "720");
    assert.strictEqual(validateQuality("320"), "320");
    assert.strictEqual(validateQuality("malicious_preset"), "best");
  });

  it("Parses timestamps accurately", () => {
    assert.strictEqual(parseTimestamp("90"), 90);
    assert.strictEqual(parseTimestamp("01:30"), 90);
    assert.strictEqual(parseTimestamp("01:00:00"), 3600);
    assert.strictEqual(isNaN(parseTimestamp("invalid")), true);
  });

  console.log("\n2. Error Mapper Tests:");
  it("Maps bot verification errors cleanly", () => {
    const err1 = mapError("Sign in to confirm you’re not a bot");
    assert.strictEqual(err1.code, ERROR_CODES.BOT_VERIFICATION);
    assert.strictEqual(err1.success, false);

    const err2 = mapError("HTTP Error 403: Forbidden");
    assert.strictEqual(err2.code, ERROR_CODES.BOT_VERIFICATION);
  });

  it("Maps login and age restricted errors", () => {
    const errLogin = mapError("This is a private video. Sign in if you've been granted access.");
    assert.strictEqual(errLogin.code, ERROR_CODES.LOGIN_REQUIRED);

    const errAge = mapError("Sign in to confirm your age. This video may be inappropriate for some users.");
    assert.strictEqual(errAge.code, ERROR_CODES.AGE_RESTRICTED);
  });

  it("Maps missing format and timeout errors", () => {
    const errFmt = mapError("Requested format is not available");
    assert.strictEqual(errFmt.code, ERROR_CODES.FORMAT_UNAVAILABLE);

    const errTimeout = mapError("Process timed out");
    assert.strictEqual(errTimeout.code, ERROR_CODES.DOWNLOAD_TIMEOUT);
  });

  console.log("\n3. Cookie Security Tests:");
  it("Validates Netscape cookie structure", () => {
    const valid = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1798765432\tSID\tsample_value";
    assert.strictEqual(isValidNetscapeCookie(valid), true);
    assert.strictEqual(isValidNetscapeCookie("invalid"), false);
  });

  it("Creates and cleanly deletes server temporary cookie file", () => {
    process.env.YOUTUBE_COOKIES = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1798765432\tSID\ttest_token";
    const cookieInfo = resolveServerCookie();
    assert.ok(cookieInfo, "Cookie file should be resolved");
    assert.strictEqual(fs.existsSync(cookieInfo.path), true);

    cleanupCookie(cookieInfo);
    assert.strictEqual(fs.existsSync(cookieInfo.path), false, "Cookie file should be deleted");
    delete process.env.YOUTUBE_COOKIES;
  });

  console.log("\n4. Binary & Diagnostics Tests:");
  await asyncIt("Detects yt-dlp and FFmpeg", async () => {
    const diag = await getDiagnostics();
    console.log(`     yt-dlp: ${diag.ytDlp.available ? "✅ " + diag.ytDlp.version : "❌ Not found"}`);
    console.log(`     FFmpeg: ${diag.ffmpeg.available ? "✅ Available" : "❌ Not found"}`);
    assert.ok(diag.directories.downloadsWritable, "Downloads folder must be writable");
  });

  console.log("\n5. Job Queue & Lifecycle Tests:");
  it("Creates, tracks, and manages download jobs", () => {
    const job = jobManager.createJob({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      format: "mp4",
      quality: "720",
      title: "Test Video"
    });

    assert.ok(job.id, "Job must have an ID");
    assert.strictEqual(job.status, "queued");

    const status = jobManager.getJob(job.id);
    assert.strictEqual(status.jobId, job.id);
    assert.strictEqual(status.format, "mp4");
  });

  console.log("\n=======================================================");
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTestSuite();
}

module.exports = { runTestSuite };
