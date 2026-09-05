module.exports = {
  apps: [
    {
      name: "vidssave-backend",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        MAX_CONCURRENT_DOWNLOADS: "3",
        JOB_TIMEOUT_MS: "300000",
        FILE_TTL_MS: "600000",
        CORS_ORIGIN: "*"
      }
    }
  ]
};
