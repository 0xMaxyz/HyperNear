# Runs the dev server on ci32 for a manual click-through. Privy only allows the origin http://localhost:5173, so
# reach it from the laptop with: ssh -F ~/.ssh-goldefi-ci/config -N -L 5173:localhost:5173 ci32
# Needs web/.env.local on the box with VITE_PRIVY_APP_ID=<public app id>. Runs 60 minutes, then stops.
cd ~/work/near_hck-web/web || exit 1
timeout 3600 pnpm exec vite
