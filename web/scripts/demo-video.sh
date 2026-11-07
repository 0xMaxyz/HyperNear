#!/bin/bash
# ci32 job that renders the demo video: sync the repo to ~/work/near_hck-web first (ci32.sh sync), then ci32.sh bg this file.
# Builds the workspace packages, serves the page on :5173 against the stand-in agent proxy on :8788, runs
# web/e2e/demo-video.mjs, and encodes demo/hypernear-demo.mp4 (H.264) with @ffmpeg-installer/ffmpeg installed into ~/ffinst.
# The output is copied to C:/Users/hamid/ci32-jobs/ for scp (Windows side of ci32). Frames for checking are written as vframe-N.png.
cd ~/work/near_hck-web && pnpm install --frozen-lockfile 2>&1 | tail -2
pnpm --filter @perps-platform/core build 2>&1 | tail -1
pnpm --filter @hypernear/client build 2>&1 | tail -1
cd web && mkdir -p ../demo
for i in $(seq 1 80); do curl -s -m 2 -o /dev/null http://localhost:5173/ || break; sleep 15; done
(VITE_AGENT_URL=http://localhost:8788 node ./node_modules/vite/bin/vite.js > /tmp/vite-web.log 2>&1 & echo $! > /tmp/vite-web.pid)
sleep 5
node e2e/demo-video.mjs 2>&1 | cut -c1-400 | head -80
kill $(cat /tmp/vite-web.pid) 2>/dev/null
FF=$(ls ~/ffinst/node_modules/@ffmpeg-installer/linux-x64/ffmpeg 2>/dev/null)
if [ -z "$FF" ]; then mkdir -p ~/ffinst && cd ~/ffinst && npm init -y >/dev/null 2>&1 && npm i @ffmpeg-installer/ffmpeg 2>&1 | tail -2; FF=$(ls ~/ffinst/node_modules/@ffmpeg-installer/linux-x64/ffmpeg 2>/dev/null); cd ~/work/near_hck-web/web; fi
echo "ffmpeg: $FF"
if [ -n "$FF" ]; then
  $FF -hide_banner -y -i ../demo/hypernear-demo.webm -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 30 -movflags +faststart -an ../demo/hypernear-demo.mp4 2>&1 | tail -3
  $FF -hide_banner -i ../demo/hypernear-demo.mp4 2>&1 | grep -E "Duration|Stream"
  $FF -hide_banner -i ../demo/hypernear-demo.webm 2>&1 | grep -E "Duration"
fi
ls -la ../demo
cp ../demo/hypernear-demo.webm ../demo/hypernear-demo.mp4 /mnt/c/Users/hamid/ci32-jobs/ 2>/dev/null
for t in 3 12 30 45 70 85 100; do [ -n "$FF" ] && $FF -hide_banner -loglevel error -y -ss $t -i ../demo/hypernear-demo.mp4 -frames:v 1 /mnt/c/Users/hamid/ci32-jobs/vframe-$t.png; done
