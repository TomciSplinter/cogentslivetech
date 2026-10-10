#!/usr/bin/env bash
# One-time setup for the Twitch broadcaster on Ubuntu 24.04.
#   sudo bash setup.sh
# Installs Chrome, a virtual screen + speaker, ffmpeg, and a service that keeps
# the stream running 24/7 (and restarts it if anything crashes).
set -euo pipefail
if [ "$(id -u)" != "0" ]; then echo "Run with sudo: sudo bash setup.sh"; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/cogents-broadcast

echo "→ installing packages"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb pulseaudio pulseaudio-utils ffmpeg wget ca-certificates fonts-noto fonts-noto-color-emoji

if ! command -v google-chrome >/dev/null; then
  echo "→ installing Google Chrome"
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi

echo "→ creating the 'streamer' user (Chrome shouldn't run as root)"
id streamer >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin streamer

echo "→ copying files to $DEST"
mkdir -p "$DEST"
cp "$HERE/broadcast.sh" "$DEST/broadcast.sh"
chmod +x "$DEST/broadcast.sh"
[ -f "$DEST/.env" ] || cp "$HERE/.env.example" "$DEST/.env"
chown -R streamer:streamer "$DEST"
chmod 600 "$DEST/.env"

echo "→ installing the service"
cat > /etc/systemd/system/cogents-broadcast.service <<EOF
[Unit]
Description=Cogents TV broadcaster (Twitch)
After=network-online.target
Wants=network-online.target

[Service]
User=streamer
WorkingDirectory=$DEST
ExecStart=$DEST/broadcast.sh
Restart=always
RestartSec=10
# fresh start every 12 hours keeps Chrome's memory in check
RuntimeMaxSec=43200

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cogents-broadcast >/dev/null

echo
echo "Done. Next:"
echo "  1) nano $DEST/.env      (paste your Twitch stream key and your TV page address)"
echo "  2) systemctl start cogents-broadcast"
echo "  3) journalctl -u cogents-broadcast -f   (watch the log)"
