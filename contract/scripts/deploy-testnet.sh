#!/usr/bin/env bash
# Run on ci32. Creates <account> via the testnet faucet (first time) and deploys hypernear to it.
# Keys stay in ~/.near-credentials/testnet (legacy keychain). Output is filtered so no secret key is printed.
# Usage: deploy-testnet.sh <account.testnet> [--redeploy | --migrate]   (--migrate runs `migrate` after deploy)
set -euo pipefail
. "$HOME/.cargo/env"
ACC="$1"; MODE="${2:-}"
cd "$(dirname "$0")/.."
redact() { sed -E 's/(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{60,}/\1:<redacted>/g'; }
cargo near build non-reproducible-wasm --features spike 2>&1 | tail -3   # testnet build: spike admin methods on
if [ ! -f "$HOME/.near-credentials/testnet/$ACC.json" ]; then
  near account create-account sponsor-by-faucet-service "$ACC" autogenerate-new-keypair \
    save-to-legacy-keychain network-config testnet create 2>&1 | redact | tail -5
  sleep 3
fi
if [ "$MODE" = "--migrate" ]; then
  near contract deploy "$ACC" use-file target/near/leash.wasm with-init-call migrate json-args '{}'     prepaid-gas '30 Tgas' attached-deposit '0 NEAR'     network-config testnet sign-with-legacy-keychain send 2>&1 | redact | tail -8
elif [ "$MODE" = "--redeploy" ]; then
  near contract deploy "$ACC" use-file target/near/leash.wasm without-init-call \
    network-config testnet sign-with-legacy-keychain send 2>&1 | redact | tail -8
else
  near contract deploy "$ACC" use-file target/near/leash.wasm with-init-call new \
    json-args "{\"admin\":\"$ACC\",\"mpc_contract\":\"v1.signer-prod.testnet\",\"hl_mainnet\":false}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    network-config testnet sign-with-legacy-keychain send 2>&1 | redact | tail -8
fi
