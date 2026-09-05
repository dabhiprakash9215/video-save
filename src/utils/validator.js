"use strict";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtu.be",
  "www.youtu.be"
]);

/**
 * Validates whether a given string is a legitimate YouTube URL.
 * Rejects non-HTTP(S) schemes, localhost, SSRF attempts, and invalid hostnames.
 * @param {string} urlStr
 * @returns {boolean}
 */
function isValidYouTubeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  const trimmed = urlStr.trim();
  if (trimmed.length < 11 || trimmed.length > 2048) return false;

  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;

    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) return false;

    // Check specific YouTube URL patterns
    if (host.includes("youtu.be")) {
      const vidId = parsed.pathname.slice(1).split("/")[0].split("?")[0];
      return Boolean(vidId && /^[a-zA-Z0-9_-]{11}$/.test(vidId));
    }

    // Standard youtube.com paths
    const path = parsed.pathname;
    if (path.startsWith("/watch")) {
      const v = parsed.searchParams.get("v");
      return Boolean(v && /^[a-zA-Z0-9_-]{11}$/.test(v));
    }

    if (path.startsWith("/shorts/") || path.startsWith("/live/") || path.startsWith("/embed/") || path.startsWith("/v/")) {
      const parts = path.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const id = parts[1].split("?")[0];
        return Boolean(id && /^[a-zA-Z0-9_-]{11}$/.test(id));
      }
    }

    // Direct video ID param if present
    if (parsed.searchParams.has("v")) {
      const v = parsed.searchParams.get("v");
      return Boolean(v && /^[a-zA-Z0-9_-]{11}$/.test(v));
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Extracts normalized 11-character YouTube video ID.
 * @param {string} urlStr
 * @returns {string|null}
 */
function extractVideoId(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  const trimmed = urlStr.trim();

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();

    if (host.includes("youtu.be")) {
      const vid = parsed.pathname.slice(1).split("/")[0].split("?")[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(vid)) return vid;
    }

    if (parsed.searchParams.has("v")) {
      const v = parsed.searchParams.get("v");
      if (/^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    }

    const path = parsed.pathname;
    if (path.startsWith("/shorts/") || path.startsWith("/live/") || path.startsWith("/embed/") || path.startsWith("/v/")) {
      const parts = path.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const id = parts[1].split("?")[0];
        if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Validates media format ('mp4' or 'mp3')
 * @param {string} format
 * @returns {'mp4'|'mp3'}
 */
function validateFormat(format) {
  if (!format || typeof format !== "string") return "mp4";
  const f = format.toLowerCase().trim();
  return f === "mp3" ? "mp3" : "mp4";
}

/**
 * Validates quality preset
 * @param {string} quality
 * @returns {string}
 */
function validateQuality(quality) {
  const validQualities = new Set(["best", "1080", "720", "480", "360", "320", "192", "128"]);
  if (typeof quality === "string" && validQualities.has(quality.toLowerCase().trim())) {
    return quality.toLowerCase().trim();
  }
  return "best";
}

/**
 * Parses timestamp strings (e.g., "01:30", "90", "01:15:30") to seconds.
 * @param {string|number} v
 * @returns {number}
 */
function parseTimestamp(v) {
  if (v === undefined || v === null || v === "") return NaN;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3 || parts.length < 2) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

module.exports = {
  isValidYouTubeUrl,
  extractVideoId,
  validateFormat,
  validateQuality,
  parseTimestamp
};
