#!/usr/bin/with-contenv sh
# with-contenv restores the container environment (SUPERVISOR_TOKEN) that
# s6-overlay strips from the CMD process on Home Assistant base images.
set -e
export DATA_DIR=/data
export PORT=8099
export PYTHONDONTWRITEBYTECODE=1
cd /app
exec python3 /app/server.py
