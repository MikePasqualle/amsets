/**
 * Mint Service — backend-controlled SPL Token-2022 minting.
 *
 * The backend holds a dedicated Solana keypair (MINT_AUTHORITY_SECRET) that
 * is set as the mint authority for every AMSETS access token at publication
 * time. This allows the backend to automatically mint exactly 1 access token
 * to a buyer the moment their purchase is confirmed on-chain, without requiring
 * the author to be online.
 *
 * Flow:
 *   1. Author publishes content → SPL mint created with MINT_AUTHORITY_PUBKEY
 *      as authority (not the author's wallet).
 *   2. Buyer calls purchase_access_sol → AccessReceipt PDA created on Solana.
 *   3. Buyer calls POST /api/v1/purchases → this service mints 1 SPL token to
 *      the buyer's ATA using the backend keypair.
 *   4. Access check on the frontend: SPL token balance > 0 → access granted.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";

/** Returns the backend's mint-authority keypair from env. */
function getMintAuthorityKeypair(): Keypair {
  const secret = process.env.MINT_AUTHORITY_SECRET;
  if (!secret) throw new Error("MINT_AUTHORITY_SECRET not set in backend .env");
  return Keypair.fromSecretKey(bs58.decode(secret));
}

/** The backend's public key — exposed so the frontend can set it as mint authority. */
export function getMintAuthorityPubkey(): string {
  return getMintAuthorityKeypair().publicKey.toBase58();
}

/**
 * Mints exactly 1 SPL Token-2022 access token to a buyer's ATA.
 *
 * - Idempotent: if the buyer already holds ≥ 1 token, returns early.
 * - The backend keypair must be the mint authority of `mintAddress`.
 * - Creates the ATA if it does not exist (backend pays rent).
 *
 * @param mintAddress    - Token-2022 mint public key
 * @param recipientWallet - Buyer's Solana wallet address
 * @param connection     - RPC connection (Helius devnet)
 * @returns tx signature string, or "already_minted" if no action was needed.
 */
export async function mintAccessTokenToUser(
  mintAddress: string,
  recipientWallet: string,
  connection: Connection
): Promise<string> {
  const mintAuthority = getMintAuthorityKeypair();
  const mint          = new PublicKey(mintAddress);
  const recipient     = new PublicKey(recipientWallet);

  // Derive the buyer's ATA for this Token-2022 mint
  const ata = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Check if already minted — avoids duplicate transactions
  try {
    const acct = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (acct.amount >= 1n) {
      console.log(`[mint] ${recipient.toBase58().slice(0, 8)} already holds token for ${mintAddress.slice(0, 8)}`);
      return "already_minted";
    }
  } catch {
    // ATA does not exist yet — will be created below
  }

  const tx = new Transaction();

  // Create ATA if it doesn't exist (idempotent instruction)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      mintAuthority.publicKey, // payer
      ata,
      recipient,
      mint,
      TOKEN_2022_PROGRAM_ID
    )
  );

  // Mint exactly 1 access token
  tx.add(
    createMintToInstruction(
      mint,
      ata,
      mintAuthority.publicKey,
      1n,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = mintAuthority.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [mintAuthority], {
    commitment: "confirmed",
  });

  console.log(`[mint] Minted 1 token → ${recipient.toBase58().slice(0, 8)}… | mint: ${mintAddress.slice(0, 8)}… | sig: ${sig.slice(0, 12)}…`);
  return sig;
}

/**
 * Mints 1 author access token to the content creator's ATA.
 * Called once when new content is published.
 *
 * @param mintAddress   - Token-2022 mint public key
 * @param authorWallet  - Author's Solana wallet address
 * @param connection    - RPC connection
 */
export async function mintAuthorToken(
  mintAddress: string,
  authorWallet: string,
  connection: Connection
): Promise<string> {
  return mintAccessTokenToUser(mintAddress, authorWallet, connection);
}
