#!/usr/bin/env bash
# Deletes every FULL-ACCESS key of the hypernear contract account: no more upgrades, deletes or transfers by anyone,
# including us. The derived Hyperliquid addresses are bound to this account id forever, so it is the custody root.
# Irreversible. The user runs it after the mainnet run is verified (docs/mainnet-runbook.md, last step).
#   lock-contract.sh <account.near> --plan   shows the keys and the command, deletes nothing
#   lock-contract.sh <account.near>          same, then asks for a typed confirmation and deletes them
# Function-call keys (if any) are listed and left alone. The account keeps its NEAR (storage + MPC deposits);
# anyone can still top it up with a plain transfer.
set -euo pipefail
ACC="${1:?usage: lock-contract.sh <account.near> [--plan]}"
PLAN=0; [ "${2:-}" = "--plan" ] && PLAN=1
NET="${NEAR_NETWORK:-mainnet}"
RPC="${NEAR_RPC_URL:-$([ "$NET" = mainnet ] && echo https://free.rpc.fastnear.com || echo https://test.rpc.fastnear.com)}"

echo "== keys of $ACC ($NET)"
KEYS_JSON=$(curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$ACC\"}}")
echo "$KEYS_JSON" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const ks = JSON.parse(s).result?.keys ?? [];
    for (const k of ks) console.log(`  ${k.public_key}  ${k.access_key.permission === "FullAccess" ? "FULL ACCESS (will be deleted)" : "function-call: " + JSON.stringify(k.access_key.permission.FunctionCall)}`);
    if (!ks.length) console.log("  (no keys: already locked, or the account does not exist)");
  })'
FULL=$(echo "$KEYS_JSON" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const ks = JSON.parse(s).result?.keys ?? [];
    console.log(ks.filter(k=>k.access_key.permission==="FullAccess").map(k=>k.public_key).join(","));
  })')
[ -n "$FULL" ] || { echo "nothing to delete"; exit 0; }
echo "== check the contract first (expect hl_mainnet true, mpc v1.signer):"
echo "+ near contract call-function as-read-only $ACC get_config json-args {} network-config $NET now"
[ "$PLAN" = 1 ] || near contract call-function as-read-only "$ACC" get_config json-args '{}' network-config "$NET" now
echo "+ near account delete-keys $ACC public-keys $FULL network-config $NET sign-with-legacy-keychain send"
[ "$PLAN" = 1 ] && { echo "(plan only: nothing deleted)"; exit 0; }
PHRASE="DELETE ALL FULL ACCESS KEYS OF $ACC"
read -r -p "irreversible. type exactly: $PHRASE > " CONFIRM
[ "$CONFIRM" = "$PHRASE" ] || { echo "not confirmed, nothing sent"; exit 1; }
near account delete-keys "$ACC" public-keys "$FULL" network-config "$NET" sign-with-legacy-keychain send 2>&1 | tail -5
echo "locked. verify: the key list above should now show no FULL ACCESS key:"
curl -s "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$ACC\"}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).result?.keys?.map(k=>k.access_key.permission))))'
