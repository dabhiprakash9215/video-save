"use strict";

const ERROR_CODES = {
  BOT_VERIFICATION: "BOT_VERIFICATION",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  VIDEO_UNAVAILABLE: "VIDEO_UNAVAILABLE",
  AGE_RESTRICTED: "AGE_RESTRICTED",
  GEO_RESTRICTED: "GEO_RESTRICTED",
  FORMAT_UNAVAILABLE: "FORMAT_UNAVAILABLE",
  YTDLP_NOT_FOUND: "YTDLP_NOT_FOUND",
  FFMPEG_NOT_FOUND: "FFMPEG_NOT_FOUND",
  DOWNLOAD_TIMEOUT: "DOWNLOAD_TIMEOUT",
  INVALID_URL: "INVALID_URL",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  SERVER_ERROR: "SERVER_ERROR"
};

const ERROR_MESSAGES = {
  [ERROR_CODES.BOT_VERIFICATION]:
    "This video could not be downloaded because YouTube requires additional verification for the download server.",
  [ERROR_CODES.LOGIN_REQUIRED]:
    "This video requires account authentication to access.",
  [ERROR_CODES.VIDEO_UNAVAILABLE]:
    "This video is unavailable, private, or has been removed from YouTube.",
  [ERROR_CODES.AGE_RESTRICTED]:
    "This video is age-restricted and cannot be downloaded without authorized server configuration.",
  [ERROR_CODES.GEO_RESTRICTED]:
    "This video is not available in the download server's geographic region.",
  [ERROR_CODES.FORMAT_UNAVAILABLE]:
    "The requested audio or video format is not available for this video.",
  [ERROR_CODES.YTDLP_NOT_FOUND]:
    "The media download engine is currently unavailable on the server.",
  [ERROR_CODES.FFMPEG_NOT_FOUND]:
    "Media conversion utility (FFmpeg) is not installed on the server.",
  [ERROR_CODES.DOWNLOAD_TIMEOUT]:
    "The download operation timed out. Please try a shorter video or lower quality setting.",
  [ERROR_CODES.INVALID_URL]:
    "Please provide a valid YouTube video URL.",
  [ERROR_CODES.RATE_LIMIT_EXCEEDED]:
    "Too many requests. Please wait a moment before starting another download.",
  [ERROR_CODES.SERVER_ERROR]:
    "An unexpected error occurred while processing the media stream."
};

/**
 * Maps raw errors or stderr strings into standardized safe user-facing error objects.
 * @param {Error|string} err
 * @returns {{ success: false, code: string, message: string }}
 */
function mapError(err) {
  const rawMsg = String(err && err.message ? err.message : err || "").toLowerCase();

  // 1. Bot verification
  if (
    rawMsg.includes("sign in to confirm you’re not a bot") ||
    rawMsg.includes("sign in to confirm you're not a bot") ||
    rawMsg.includes("bot verification") ||
    rawMsg.includes("http error 403") ||
    rawMsg.includes("forbidden") ||
    rawMsg.includes("bot_verification")
  ) {
    return {
      success: false,
      code: ERROR_CODES.BOT_VERIFICATION,
      message: ERROR_MESSAGES[ERROR_CODES.BOT_VERIFICATION]
    };
  }

  // 2. Age-restricted (checked before general sign in)
  if (
    rawMsg.includes("age-restricted") ||
    rawMsg.includes("confirm your age") ||
    rawMsg.includes("inappropriate for some users")
  ) {
    return {
      success: false,
      code: ERROR_CODES.AGE_RESTRICTED,
      message: ERROR_MESSAGES[ERROR_CODES.AGE_RESTRICTED]
    };
  }

  // 3. Login / Private video
  if (
    rawMsg.includes("sign in") ||
    rawMsg.includes("private video") ||
    rawMsg.includes("login required") ||
    rawMsg.includes("granted access")
  ) {
    return {
      success: false,
      code: ERROR_CODES.LOGIN_REQUIRED,
      message: ERROR_MESSAGES[ERROR_CODES.LOGIN_REQUIRED]
    };
  }

  // 4. Geo-restricted
  if (
    rawMsg.includes("not available in your country") ||
    rawMsg.includes("geo restricted") ||
    rawMsg.includes("geographic")
  ) {
    return {
      success: false,
      code: ERROR_CODES.GEO_RESTRICTED,
      message: ERROR_MESSAGES[ERROR_CODES.GEO_RESTRICTED]
    };
  }

  // 5. Video Unavailable
  if (
    rawMsg.includes("video unavailable") ||
    rawMsg.includes("does not exist") ||
    rawMsg.includes("this video has been removed")
  ) {
    return {
      success: false,
      code: ERROR_CODES.VIDEO_UNAVAILABLE,
      message: ERROR_MESSAGES[ERROR_CODES.VIDEO_UNAVAILABLE]
    };
  }

  // 6. Format Unavailable
  if (
    rawMsg.includes("requested format is not available") ||
    rawMsg.includes("no video formats found") ||
    rawMsg.includes("format_unavailable")
  ) {
    return {
      success: false,
      code: ERROR_CODES.FORMAT_UNAVAILABLE,
      message: ERROR_MESSAGES[ERROR_CODES.FORMAT_UNAVAILABLE]
    };
  }

  // 7. Timeout
  if (
    rawMsg.includes("timed out") ||
    rawMsg.includes("timeout") ||
    rawMsg.includes("download_timeout")
  ) {
    return {
      success: false,
      code: ERROR_CODES.DOWNLOAD_TIMEOUT,
      message: ERROR_MESSAGES[ERROR_CODES.DOWNLOAD_TIMEOUT]
    };
  }

  // 8. Binaries
  if (rawMsg.includes("yt-dlp") && (rawMsg.includes("not found") || rawMsg.includes("enoent"))) {
    return {
      success: false,
      code: ERROR_CODES.YTDLP_NOT_FOUND,
      message: ERROR_MESSAGES[ERROR_CODES.YTDLP_NOT_FOUND]
    };
  }

  if (rawMsg.includes("ffmpeg") && (rawMsg.includes("not found") || rawMsg.includes("enoent") || rawMsg.includes("missing"))) {
    return {
      success: false,
      code: ERROR_CODES.FFMPEG_NOT_FOUND,
      message: ERROR_MESSAGES[ERROR_CODES.FFMPEG_NOT_FOUND]
    };
  }

  // 9. Invalid URL
  if (rawMsg.includes("invalid youtube url") || rawMsg.includes("invalid url")) {
    return {
      success: false,
      code: ERROR_CODES.INVALID_URL,
      message: ERROR_MESSAGES[ERROR_CODES.INVALID_URL]
    };
  }

  return {
    success: false,
    code: ERROR_CODES.SERVER_ERROR,
    message: ERROR_MESSAGES[ERROR_CODES.SERVER_ERROR]
  };
}

module.exports = {
  ERROR_CODES,
  ERROR_MESSAGES,
  mapError
};
