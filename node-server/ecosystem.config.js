module.exports = {
  apps: [
    {
      name: "server",
      script: "server.js",
      cwd: __dirname,
      node_args: "--max-old-space-size=1024 --expose-gc",
      max_memory_restart: "650M",
      restart_delay: 2000,
      kill_timeout: 5000,
      autorestart: true,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "orchestrator",
      script: "orchestrator.js",
      cwd: __dirname,
      node_args: "--expose-gc",
      max_memory_restart: "150M",
      restart_delay: 3000,
      autorestart: true
    }
  ]
};
