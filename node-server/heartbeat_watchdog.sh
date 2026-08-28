#!/bin/bash
# Autonomous Orchestrator Heartbeat Watchdog
HEARTBEAT_FILE="/root/nother/node-server/heartbeat.txt"
CURRENT_TIME=$(date +%s)

if [ -f "$HEARTBEAT_FILE" ]; then
    LAST_MTIME=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE" 2>/dev/null)
    DIFF=$((CURRENT_TIME - LAST_MTIME))
    if [ $DIFF -gt 60 ]; then
        echo "[WATCHDOG] Orchestrator heartbeat stale ($DIFF sec). Reviving orchestrator..." >> /var/log/orchestrator_watchdog.log
        cd "/root/nother/node-server" && pm2 restart orchestrator --update-env >> /var/log/orchestrator_watchdog.log 2>&1
    fi
else
    echo "[WATCHDOG] Heartbeat file missing. Ensuring orchestrator is running..." >> /var/log/orchestrator_watchdog.log
    cd "/root/nother/node-server" && pm2 start orchestrator.js --name orchestrator >> /var/log/orchestrator_watchdog.log 2>&1
fi
