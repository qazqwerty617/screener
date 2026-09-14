module.exports = {
  apps: [
    {
      name: "server",
      script: "server.js",
      cwd: __dirname,
      node_args: "--max-old-space-size=1536 --inspect=127.0.0.1:9229",
      max_memory_restart: "1200M",
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
      node_args: "--max-old-space-size=512",
      max_memory_restart: "350M",
      restart_delay: 3000,
      autorestart: true
    },
    {
      name: "cryptoscreen-go",
      script: "/root/cryptoscreen/go-scanner/scanner",
      cwd: "/root/cryptoscreen/go-scanner",
      restart_delay: 3000,
      autorestart: true
    }
  ]
};
