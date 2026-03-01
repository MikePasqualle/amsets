/**
 * burn-unknown-tokens.ts
 * Finds all SPL Token-2022 accounts in the given wallet and burns
 * tokens where our backend is the PermanentDelegate (unknown/orphaned tokens).
 *
 * Usage:
 *   npx ts-node scripts/burn-unknown-tokens.ts <walletAddress>
 */

import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getPermanentDelegate,
  getAssociatedTokenAddressSync,
  createBurnInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";

const WALLET_ADDRESS = process.argv[2];
if (!WALLET_ADDRESS) {
  console.error("Usage: npx ts-node scripts/burn-unknown-tokens.ts <walletAddress>");
  process.exit(1);
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  const secret = process.env.MINT_AUTHORITY_SECRET;
  if (!secret) throw new Error("MINT_AUTHORITY_SECRET not set");
  const auth = Keypair.fromSecretKey(bs58.decode(secret));

  const wallet = new PublicKey(WALLET_ADDRESS);
  console.log(`\nScanning wallet: ${WALLET_ADDRESS}`);
  console.log(`Backend authority: ${auth.publicKey.toBase58()}\n`);

  // Fetch all Token-2022 accounts for the wallet
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, {
    programId: TOKEN_2022_PROGRAM_ID,
  });

  if (tokenAccounts.value.length === 0) {
    console.log("No SPL Token-2022 accounts found in this wallet.");
    return;
  }

  console.log(`Found ${tokenAccounts.value.length} Token-2022 account(s):`);

  for (const { pubkey, account } of tokenAccounts.value) {
    const parsed   = account.data.parsed.info;
    const mintAddr = parsed.mint as string;
    const amount   = BigInt(parsed.tokenAmount.amount as string);
    const decimals = parsed.tokenAmount.decimals as number;
    const uiAmount = parsed.tokenAmount.uiAmountString as string;

    console.log(`\n  Mint:    ${mintAddr}`);
    console.log(`  Account: ${pubkey.toBase58()}`);
    console.log(`  Balance: ${uiAmount} (raw: ${amount})`);

    if (amount === 0n) {
      console.log(`  → Skipping (already empty)`);
      continue;
    }

    // Check if our backend is the PermanentDelegate for this mint
    let isPD = false;
    try {
      const mintInfo = await getMint(connection, new PublicKey(mintAddr), "confirmed", TOKEN_2022_PROGRAM_ID);
      const pd = getPermanentDelegate(mintInfo);
      isPD = pd?.delegate?.toBase58() === auth.publicKey.toBase58();
    } catch (err: any) {
      console.log(`  → Cannot read mint info: ${err.message?.slice(0, 60)}`);
    }

    if (!isPD) {
      console.log(`  → Skipping (backend is NOT the PermanentDelegate for this mint)`);
      continue;
    }

    console.log(`  ✓ Backend IS the PermanentDelegate — burning ${amount} token(s)…`);

    try {
      const mintPubkey = new PublicKey(mintAddr);
      const ata = getAssociatedTokenAddressSync(mintPubkey, wallet, false, TOKEN_2022_PROGRAM_ID);

      const tx = new Transaction();
      tx.add(
        createBurnInstruction(
          ata,           // token account to burn from
          mintPubkey,    // mint
          auth.publicKey, // authority (PermanentDelegate)
          amount,        // burn all tokens in this account
          [],
          TOKEN_2022_PROGRAM_ID
        )
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash        = blockhash;
      tx.lastValidBlockHeight   = lastValidBlockHeight;
      tx.feePayer               = auth.publicKey;

      const sig = await sendAndConfirmTransaction(connection, tx, [auth], { commitment: "confirmed" });
      console.log(`  ✓ Burned! Signature: ${sig}`);
      console.log(`    Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    } catch (err: any) {
      console.error(`  ✗ Burn failed: ${err.message}`);
    }
  }

  console.log("\nDone.\n");
}

main().catch(console.error);
