#!/bin/bash
# AMSETS Smart Contract Deploy Script
# Deploys amsets-registry to Solana Devnet
#
# Deployer wallet: CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8
# Program ID:      B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG
#
# BEFORE RUNNING: Fund the deployer wallet with at least 3 SOL from:
#   https://faucet.solana.com → paste CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8
#   OR send from Phantom: 3 SOL to CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8

set -e

CONTRACTS_DIR="$(cd "$(dirname "$0")/amsets-contracts" && pwd)"
DEPLOY_DIR="$CONTRACTS_DIR/target/deploy"
SO_FILE="$DEPLOY_DIR/amsets_registry.so"
KEYPAIR_FILE="$DEPLOY_DIR/amsets_registry-keypair.json"
PROGRAM_ID="B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG"

echo "=== AMSETS Contract Deploy ==="
echo "Program ID: $PROGRAM_ID"
echo ""

# Check balance
BALANCE=$(solana balance --url devnet 2>/dev/null | awk '{print $1}')
echo "Deployer balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2" | bc -l 2>/dev/null || echo 1) )); then
  echo ""
  echo "❌ Insufficient SOL. Need at least 2 SOL for deployment."
  echo ""
  echo "Fund the deployer wallet:"
  echo "  1. Go to https://faucet.solana.com"
  echo "  2. Paste: CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8"
  echo "  3. Request 2-3 SOL"
  echo "  OR send from Phantom devnet wallet → CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8"
  echo ""
  echo "Then run: bash deploy-contract.sh"
  exit 1
fi

echo "✓ Balance OK"
echo ""

# Set devnet
solana config set --url devnet > /dev/null 2>&1

echo "Deploying program..."
solana program deploy \
  --program-id "$KEYPAIR_FILE" \
  --url devnet \
  "$SO_FILE"

echo ""
echo "✅ Contract deployed!"
echo "   Program ID: $PROGRAM_ID"
echo "   Verify: https://solscan.io/account/$PROGRAM_ID?cluster=devnet"
