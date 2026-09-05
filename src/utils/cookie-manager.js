"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const SECURE_COOKIE_DIR = path.join(os.tmpdir(), "vidssave_secure_auth");

function ensureCookieDir() {
  if (!fs.existsSync(SECURE_COOKIE_DIR)) {
    fs.mkdirSync(SECURE_COOKIE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Validates whether string has basic characteristics of Netscape HTTP Cookie format
 * @param {string} text
 * @returns {boolean}
 */
function isValidNetscapeCookie(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;

  const lines = trimmed.split(/\r?\n/);
  let validTabLines = 0;
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    // Netscape format has tab-delimited columns: domain, flag, path, secure, expiration, name, value
    const parts = l.split("\t");
    if (parts.length >= 6) {
      validTabLines++;
    }
  }
  return validTabLines > 0 || trimmed.includes("youtube.com") || trimmed.includes(".google.com");
}

/**
 * Creates a secure, temporary cookie file if server-side cookies are configured via ENV.
 * Strictly ignores any client-supplied cookies.
 * @returns {{ path: string, isTemp: boolean } | null}
 */
function resolveServerCookie() {
  ensureCookieDir();

  // 1. Direct file path from ENV
  const envFile = process.env.YOUTUBE_COOKIES_FILE || process.env.COOKIES_FILE;
  if (envFile && fs.existsSync(envFile)) {
    try {
      const stats = fs.statSync(envFile);
      if (stats.isFile() && stats.size > 20) {
        return { path: path.resolve(envFile), isTemp: false };
      }
    } catch { }
  }

  // 2. Cookie contents from ENV string or Base64
  const envContent = process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIES_BASE64;
  if (envContent && typeof envContent === "string" && envContent.trim().length > 20) {
    let content = envContent.trim();

    // Check if base64 encoded
    if (!content.includes("\n") && !content.includes("\t") && content.length > 50) {
      try {
        const decoded = Buffer.from(content, "base64").toString("utf8");
        if (isValidNetscapeCookie(decoded)) {
          content = decoded;
        }
      } catch { }
    }

    if (isValidNetscapeCookie(content)) {
      try {
        const randomId = crypto.randomBytes(12).toString("hex");
        const tempFilePath = path.join(SECURE_COOKIE_DIR, `auth_${randomId}.txt`);
        fs.writeFileSync(tempFilePath, content, { encoding: "utf8", mode: 0o600 });
        return { path: tempFilePath, isTemp: true };
      } catch (err) {
        console.error("[CookieManager] Failed to write secure cookie file:", err.message);
      }
    }
  }

  return null;
}

/**
 * Safely cleans up temporary cookie files without logging contents.
 * @param {{ path: string, isTemp: boolean } | null} cookieInfo
 */
function cleanupCookie(cookieInfo) {
  if (!cookieInfo || !cookieInfo.isTemp || !cookieInfo.path) return;
  try {
    if (fs.existsSync(cookieInfo.path)) {
      fs.unlinkSync(cookieInfo.path);
    }
  } catch (err) {
    // Silent fail without leaking path
  }
}

/**
 * Cleanup all stale temp cookies on startup/exit
 */
function cleanupAllStaleCookies() {
  try {
    if (!fs.existsSync(SECURE_COOKIE_DIR)) return;
    const files = fs.readdirSync(SECURE_COOKIE_DIR);
    for (const file of files) {
      if (file.startsWith("auth_")) {
        try {
          fs.unlinkSync(path.join(SECURE_COOKIE_DIR, file));
        } catch { }
      }
    }
  } catch { }
}

module.exports = {
  resolveServerCookie,
  cleanupCookie,
  cleanupAllStaleCookies,
  isValidNetscapeCookie
};
