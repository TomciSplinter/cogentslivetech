#!/usr/bin/env bash
# Cogents TV broadcaster: opens the TV page in a real Chrome on a virtual screen,
# captures picture + sound, and streams it to Twitch 24/7.
#
#   virtual screen (Xvfb) → Chrome showing /#/tv → ffmpeg → rtmp://…twitch
#   virtual speaker (PulseAudio) ───────────────────┘
#
# Settings come from .env next to this script (see .env.example).
# If anything crashes, the script exits and systemd restarts it.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-30}"
PRESET="${PRESET:-veryfast}"         # x264 speed: ultrafast on a 2-core server, veryfast on 4+ cores
VIDEO_BITRATE="${VIDEO_BITRATE:-3000k}"
AUDIO="${AUDIO:-pulse}"               # pulse = real bot voices, none = silent (testing)
DISPLAY_NUM="${DISPLAY_NUM:-99}"
CHROME="${CHROME_BIN:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)}"
INGEST="${TWITCH_INGEST:-rtmp://live.twitch.tv/app}"
OUTPUT="${OUTPUT:-}"                   # set to a file path to record locally instead of streaming

if [ -z "${TV_URL:-}" ]; then echo "TV_URL is missing in .env (e.g. https://cogents.live/?sound&quality=0.7#/tv)"; exit 1; fi
if [ -z "$OUTPUT" ] && [ -z "${TWITCH_STREAM_KEY:-}" ]; then echo "TWITCH_STREAM_KEY is missing in .env"; exit 1; fi
if [ -z "$CHROME" ]; then echo "Chrome not found. Run setup.sh first."; exit 1; fi

export DISPLAY=":${DISPLAY_NUM}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/cogents-runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
PROFILE="$(mktemp -d /tmp/cogents-chrome.XXXXXX)"

pids=()
cleanup() {
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$PROFILE"
}
trap cleanup EXIT INT TERM

# 1) virtual screen
rm -f "/tmp/.X${DISPLAY_NUM}-lock"
Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp >/dev/null 2>&1 &
pids+=($!)
sleep 2

# 2) virtual speaker
AUDIO_IN=(-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100)
if [ "$AUDIO" = "pulse" ]; then
  pulseaudio --kill >/dev/null 2>&1 || true
  pulseaudio --daemonize=no --exit-idle-time=-1 --disallow-exit >/dev/null 2>&1 &
  pids+=($!)
  sleep 2
  pactl load-module module-null-sink sink_name=cogents sink_properties=device.description=cogents >/dev/null
  pactl set-default-sink cogents
  export PULSE_SINK=cogents
  AUDIO_IN=(-f pulse -thread_queue_size 1024 -i cogents.monitor)
fi

# 3) Chrome showing the TV page (sound allowed without a click)
"$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --disable-infobars --noerrdialogs \
  --disable-session-crashed-bubble --disable-features=Translate,MediaRouter \
  --autoplay-policy=no-user-gesture-required \
  --ignore-gpu-blocklist --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --window-position=0,0 --window-size="${WIDTH},${HEIGHT}" --kiosk \
  ${CHROME_EXTRA_FLAGS:-} \
  "$TV_URL" >/dev/null 2>&1 &
CHROME_PID=$!
pids+=($CHROME_PID)
sleep "${PAGE_LOAD_WAIT:-12}"

# 4) capture and stream
DEST="${OUTPUT:-${INGEST}/${TWITCH_STREAM_KEY:-}}"
FORMAT=(-f flv)
echo "[broadcast] streaming ${WIDTH}x${HEIGHT}@${FPS} to ${OUTPUT:-Twitch}"
ffmpeg -hide_banner -loglevel warning \
  -thread_queue_size 1024 -f x11grab -draw_mouse 0 -video_size "${WIDTH}x${HEIGHT}" -framerate "$FPS" -i "$DISPLAY" \
  "${AUDIO_IN[@]}" \
  -c:v libx264 -preset "$PRESET" -tune zerolatency -pix_fmt yuv420p \
  -b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_BITRATE" -bufsize "$((${VIDEO_BITRATE%k} * 2))k" -g "$((FPS * 2))" \
  -c:a aac -b:a 160k -ar 44100 \
  ${MAX_SECONDS:+-t "$MAX_SECONDS"} \
  "${FORMAT[@]}" "$DEST" &
FF=$!
pids+=($FF)

# if Chrome or ffmpeg dies, exit so systemd restarts everything cleanly
while kill -0 "$FF" 2>/dev/null && kill -0 "$CHROME_PID" 2>/dev/null; do sleep 5; done
echo "[broadcast] a process stopped, exiting for restart"
