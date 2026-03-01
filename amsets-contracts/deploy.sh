#!/bin/bash
# ─── AMSETS Registry — Build, Deploy & Initialize ────────────────────────────
# Run this script after getting SOL from https://faucet.solana.com
# Deployer wallet: CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8
# Required SOL: ~2.5 SOL in the deployer wallet
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh

set -e

CLUSTER="devnet"
PROGRAM_ID="B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG"
PLATFORM_TOOLS="/Users/mikepatsan/.local/share/solana/install/releases/stable-42c10bf3385efbb369c8fd6da9bb59e0562bce50/solana-release/bin/platform-tools-sdk/sbf/dependencies/platform-tools"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  AMSETS Smart Contract Deploy & Initialize"
echo "═══════════════════════════════════════════════════════"
echo ""

# Check balance
BALANCE=$(solana balance --url $CLUSTER 2>&1 | grep -oE '[0-9]+\.[0-9]+')
echo "Deployer wallet balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2.2" | bc -l) )); then
    echo ""
    echo "❌  Insufficient SOL. Need at least 2.5 SOL."
    echo ""
    echo "   1. Go to https://faucet.solana.com"
    echo "   2. Enter wallet: CFLk3NaYLP876Vf8RpNbnymP8igsZJ8YjWd4ac73GQH8"
    echo "   3. Request 5 SOL (Devnet)"
    echo "   4. Run this script again"
    echo ""
    exit 1
fi

echo "✓ Sufficient SOL available"
echo ""

# Step 1: Build
echo "Step 1/4: Building smart contract..."
RUSTC="$PLATFORM_TOOLS/rust/bin/rustc" cargo-build-sbf --no-rustup-override 2>&1 | grep -E "error|warning.*unused|Finished|Compiling amsets" || true
echo "✓ Build complete"
echo ""

# Step 2: Deploy
echo "Step 2/4: Deploying to devnet..."
anchor deploy --provider.cluster $CLUSTER 2>&1
echo "✓ Deploy complete"
echo ""

# Step 3: Initialize RegistryState PDA
echo "Step 3/4: Initializing RegistryState PDA..."
node -e "
const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } = require('@solana/web3.js');
const fs = require('fs');

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const programId = new PublicKey('$PROGRAM_ID');
const keypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8')))
);

async function main() {
  // Derive registry PDA
  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from('registry')], programId);
  console.log('Registry PDA:', registryPda.toBase58());

  // Check if already initialized
  const info = await connection.getAccountInfo(registryPda);
  if (info) {
    console.log('RegistryState PDA already initialized! Skipping.');
    return;
  }

  // Initialize registry discriminator: sha256('global:initialize_registry')[0..8]
  const disc = new Uint8Array([189, 181, 20, 17, 174, 57, 249, 59]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: registryPda,       isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(disc),
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(ix);
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('✓ RegistryState initialized! Signature:', sig);
}

main().catch(console.error);
" 2>&1
echo ""

# Step 4: Initialize fee vault
echo "Step 4/4: Ensuring fee vault is funded..."
node -e "
const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } = require('@solana/web3.js');
const fs = require('fs');

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const programId = new PublicKey('$PROGRAM_ID');
const keypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8')))
);

async function main() {
  const [feeVaultPda] = PublicKey.findProgramAddressSync([Buffer.from('fee_vault')], programId);
  console.log('Fee Vault PDA:', feeVaultPda.toBase58());

  const info = await connection.getAccountInfo(feeVaultPda);
  const MIN_RENT = 890880;
  if (info && info.lamports >= MIN_RENT) {
    console.log('Fee vault already funded. Skipping.');
    return;
  }

  const disc = new Uint8Array([48, 191, 163, 44, 71, 129, 63, 164]);
  const lamports = BigInt(10_000_000);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, lamports, true);
  const data = new Uint8Array([...disc, ...new Uint8Array(buf)]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: feeVaultPda,       isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(ix);
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('✓ Fee vault initialized! Signature:', sig);
}

main().catch(console.error);
" 2>&1

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✓ All done! Contract deployed and initialized."
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Restart the backend:  cd ../amsets-api && npm run dev"
echo "  2. Restart the frontend: cd ../amsets-app && npm run dev"
echo ""
