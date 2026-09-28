"use strict";

// PM2 exports its own process options into a managed process's environment.
// Forwarding them through --update-env can turn the target into the caller
// (including its memory limit, script, and Node arguments).
const CONTROL_KEYS = new Set([
  "name", "namespace", "cwd", "script", "args", "node_args", "exec_mode",
  "exec_interpreter", "instances", "instance_var", "max_memory_restart",
  "restart_delay", "kill_timeout", "listen_timeout", "autorestart", "watch",
  "ignore_watch", "merge_logs", "out_file", "error_file", "log_file",
  "min_uptime", "max_restarts", "cron_restart", "exp_backoff_restart_delay",
  "status", "restart_time", "unstable_restarts", "created_at", "exit_code",
  "unique_id", "version", "vizion", "automation", "treekill", "env",
  "NODE_APP_INSTANCE", "NODE_UNIQUE_ID",
]);
function pm2Environment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !CONTROL_KEYS.has(key) && !key.startsWith("pm_")));
}
function memoryLimitMB(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([KMG])?$/i.exec(String(value));
  if (!match) throw new Error("Invalid PM2 memory limit");
  const bytes = Number(match[1]) * ({ K: 1024, M: 1048576, G: 1073741824 }[match[2]?.toUpperCase()] || 1);
  if (!(bytes > 0)) throw new Error("Invalid PM2 memory limit");
  return bytes / 1048576;
}
module.exports = { pm2Environment, memoryLimitMB };
