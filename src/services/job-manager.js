"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { executeDownload, DOWNLOAD_DIR } = require("./downloader");
const { mapError } = require("../utils/error-mapper");
const { cleanupAllStaleCookies } = require("../utils/cookie-manager");

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "3", 10);
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "300000", 10); // 5 minutes
const FILE_TTL_MS = parseInt(process.env.FILE_TTL_MS || "600000", 10); // 10 minutes

class JobManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    this.activeWorkers = 0;
    this.runningProcesses = new Map(); // jobId -> ChildProcess

    // Start background cleanup interval (every 2 minutes)
    this.cleanupTimer = setInterval(() => this.cleanupExpiredJobs(), 2 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /**
   * Create a new download job and enqueue it
   */
  createJob({ url, format, quality, title = "" }) {
    const id = crypto.randomBytes(12).toString("hex");
    const job = {
      id,
      url,
      format,
      quality,
      title,
      status: "queued", // 'queued' | 'processing' | 'completed' | 'failed'
      progress: 0,
      stage: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      filePath: null,
      filename: null,
      fileSize: 0,
      downloadCount: 0,
      error: null,
      errorCode: null
    };

    this.jobs.set(id, job);
    this.scheduleQueue();
    return job;
  }

  /**
   * Retrieve job by ID with safe user-facing attributes
   */
  getJob(id) {
    const job = this.jobs.get(id);
    if (!job) return null;

    return {
      success: job.status !== "failed",
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      title: job.title,
      format: job.format,
      quality: job.quality,
      filename: job.filename,
      fileSize: job.fileSize,
      downloadUrl: job.status === "completed" ? `/api/download/${job.id}/file` : null,
      code: job.errorCode,
      message: job.error
    };
  }

  scheduleQueue() {
    setImmediate(() => this.processNext());
  }

  async processNext() {
    if (this.activeWorkers >= MAX_CONCURRENT) return;

    // Find next queued job
    let nextJob = null;
    for (const job of this.jobs.values()) {
      if (job.status === "queued") {
        nextJob = job;
        break;
      }
    }

    if (!nextJob) return;

    this.activeWorkers++;
    nextJob.status = "processing";
    nextJob.stage = "downloading";
    nextJob.startedAt = Date.now();

    let timeoutHandle = null;

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const timeoutErr = new Error("DOWNLOAD_TIMEOUT");
          timeoutErr.code = "DOWNLOAD_TIMEOUT";
          // Kill the process if running
          const proc = this.runningProcesses.get(nextJob.id);
          if (proc) {
            try { proc.kill("SIGKILL"); } catch { }
          }
          reject(timeoutErr);
        }, JOB_TIMEOUT_MS);
      });

      const downloadPromise = executeDownload(
        nextJob,
        (progressInfo) => {
          nextJob.progress = progressInfo.progress || 0;
          nextJob.stage = progressInfo.stage || "downloading";
        },
        (proc) => {
          this.runningProcesses.set(nextJob.id, proc);
        }
      );

      const result = await Promise.race([downloadPromise, timeoutPromise]);

      clearTimeout(timeoutHandle);
      this.runningProcesses.delete(nextJob.id);

      nextJob.status = "completed";
      nextJob.progress = 100;
      nextJob.stage = "completed";
      nextJob.finishedAt = Date.now();
      nextJob.filePath = result.filePath;
      nextJob.filename = result.filename;
      nextJob.fileSize = result.fileSize;
    } catch (err) {
      clearTimeout(timeoutHandle);
      this.runningProcesses.delete(nextJob.id);

      const mapped = mapError(err);
      nextJob.status = "failed";
      nextJob.stage = "failed";
      nextJob.finishedAt = Date.now();
      nextJob.error = mapped.message;
      nextJob.errorCode = mapped.code;

      // Clean any partially created files
      if (nextJob.filePath && fs.existsSync(nextJob.filePath)) {
        try { fs.unlinkSync(nextJob.filePath); } catch { }
      }
    } finally {
      this.activeWorkers--;
      this.scheduleQueue();
    }
  }

  /**
   * Mark job file as downloaded; delete file after grace period
   */
  scheduleFileDeletion(jobId, delayMs = 5000) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.downloadCount++;

    setTimeout(() => {
      if (job.filePath && fs.existsSync(job.filePath)) {
        try {
          fs.unlinkSync(job.filePath);
          job.filePath = null;
        } catch { }
      }
    }, delayMs);
  }

  /**
   * Periodic garbage collector for expired jobs and orphaned files
   */
  cleanupExpiredJobs() {
    const now = Date.now();

    for (const [id, job] of this.jobs.entries()) {
      const isExpired = (now - job.createdAt) > FILE_TTL_MS;
      if (isExpired) {
        if (job.filePath && fs.existsSync(job.filePath)) {
          try { fs.unlinkSync(job.filePath); } catch { }
        }
        this.jobs.delete(id);
      }
    }

    // Clean any unindexed orphan files in DOWNLOAD_DIR older than 10 mins
    try {
      if (fs.existsSync(DOWNLOAD_DIR)) {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        for (const file of files) {
          if (file === ".gitkeep" || file === ".write_test") continue;
          const fullPath = path.join(DOWNLOAD_DIR, file);
          try {
            const stats = fs.statSync(fullPath);
            if (stats.isFile() && (now - stats.mtimeMs) > FILE_TTL_MS) {
              fs.unlinkSync(fullPath);
            }
          } catch { }
        }
      }
    } catch { }
  }

  /**
   * Graceful shutdown: kill child processes and clean up
   */
  shutdown() {
    clearInterval(this.cleanupTimer);
    for (const proc of this.runningProcesses.values()) {
      try { proc.kill("SIGTERM"); } catch { }
    }
    this.runningProcesses.clear();
    cleanupAllStaleCookies();
  }

  getStats() {
    let queued = 0, processing = 0, completed = 0, failed = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "queued") queued++;
      else if (job.status === "processing") processing++;
      else if (job.status === "completed") completed++;
      else if (job.status === "failed") failed++;
    }
    return {
      activeWorkers: this.activeWorkers,
      maxConcurrent: MAX_CONCURRENT,
      totalTrackedJobs: this.jobs.size,
      queued,
      processing,
      completed,
      failed
    };
  }
}

const jobManager = new JobManager();

module.exports = jobManager;
