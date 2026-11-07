#!/usr/bin/env bash
# MAINNET deploy of the hypernear contract. The user runs this; nothing here runs unattended.
#   deploy-mainnet.sh <account.near> --plan   prints every step and command, runs none
#   deploy-mainnet.sh <account.near>          builds, checks, asks for the account id typed back, deploys + init
# Default build only (NO --features spike): the ABI must not contain sign_raw / admin_sign_hl / migrate.
# Init: new(admin = <account>, mpc_contract = v1.signer, hl_mainnet = true)  ->  chain_tag "near-mainnet", HL "Mainnet".
# It STOPS before deleting the full-access key: that is lock-contract.sh, run after the mainnet run is verified.
# Key: ~/.near-credentials/mainnet/<account>.json (legacy keychain), never printed.
set -euo pipefail
ACC="${1:?usage: deploy-mainnet.sh <account.near> [--plan]}"
PLAN=0; [ "${2:-}" = "--plan" ] && PLAN=1
MPC=v1.signer
NET=mainnet
WASM=target/near/leash.wasm
ABI=target/near/leash_abi.json
cd "$(dirname "$0")/.."

if [[ ! "$ACC" =~ ^[a-z0-9_.-]+\.(near|tg)$ ]]; then
  echo "refusing: $ACC is not a named mainnet account (*.near / *.tg); testnet accounts use deploy-testnet.sh" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$*"; }
# shellcheck disable=SC2145
run() { printf '+ %s\n' "$*"; [ "$PLAN" = 1 ] || "$@"; }
INIT_ARGS="{\"admin\":\"$ACC\",\"mpc_contract\":\"$MPC\",\"hl_mainnet\":true}"

step "1. default build (no spike feature)"
[ "$PLAN" = 1 ] || . "$HOME/.cargo/env"
run cargo near build non-reproducible-wasm

step "2. ABI must not contain the spike-only methods"
printf '+ grep sign_raw|admin_sign_hl|migrate in %s (expect none)\n' "$ABI"
if [ "$PLAN" = 0 ]; then
  if grep -qE '"name": *"(sign_raw|admin_sign_hl|migrate)"' "$ABI"; then echo "ABORT: spike methods in the build" >&2; exit 1; fi
  echo "ok: no spike methods"
fi

step "3. wasm hash and size"
printf '+ sha256sum %s; stat size\n' "$WASM"
if [ "$PLAN" = 0 ]; then
  sha256sum "$WASM"
  SIZE=$(stat -c %s "$WASM")
  echo "size $SIZE bytes -> storage ~$(awk "BEGIN{printf \"%.2f\", $SIZE/100000}") NEAR locked on the account (1 NEAR per 100 kB)"
fi

step "4. account state (must exist, hold >= storage + 1 NEAR, no contract yet)"
run near account view-account-summary "$ACC" network-config "$NET" now

step "5. deploy + init new(): THE MAINNET TRANSACTION"
printf '+ near contract deploy %s use-file %s with-init-call new json-args %s prepaid-gas 30 Tgas attached-deposit 0 NEAR network-config %s sign-with-legacy-keychain send\n' "$ACC" "$WASM" "$INIT_ARGS" "$NET"
if [ "$PLAN" = 0 ]; then
  read -r -p "type the account id ($ACC) to deploy to MAINNET: " CONFIRM
  [ "$CONFIRM" = "$ACC" ] || { echo "not confirmed, nothing sent"; exit 1; }
  near contract deploy "$ACC" use-file "$WASM" with-init-call new json-args "$INIT_ARGS" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config "$NET" sign-with-legacy-keychain send 2>&1 \
    | sed -E 's/(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{60,}/\1:<redacted>/g' | tail -8
fi

step "6. verify: config says mainnet, MPC v1.signer"
run near contract call-function as-read-only "$ACC" get_config json-args '{}' network-config "$NET" now

step "next (NOT done here)"
echo "  - create the NEAR agent sub-account + function-call key BEFORE locking (docs/mainnet-runbook.md, step 3)"
echo "  - run the mainnet flow, then: contract/scripts/lock-contract.sh $ACC"
