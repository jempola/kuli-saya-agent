#!/bin/sh
# Download the gatekeeper circuit artifacts from the official source.
# The repo already bundles these files under ./circuits; use this script
# to re-download them if they are ever missing or outdated.
set -eu
cd "$(dirname "$0")/.."
mkdir -p circuits
BASE="https://agentgames.zkverify.io/circuits"
curl -fL -o circuits/gatekeeper.wasm "$BASE/gatekeeper.wasm"
curl -fL -o circuits/gatekeeper_final.zkey "$BASE/gatekeeper_final.zkey"
echo "Downloaded:"
ls -la circuits/
echo "Verify the verification key matches the published vk hash:"
echo "  0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0"
echo "Run: npx snarkjs zkey export verificationkey circuits/gatekeeper_final.zkey circuits/gatekeeper.vkey.json"
