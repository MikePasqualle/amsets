/**
 * Mint Service — SPL Token-2022 with PermanentDelegate + TokenMetadata.
 *
 * Every AMSETS access token mint has:
 *  - TransferFeeConfig : author royalty on every transfer (bps-based)
 *  - PermanentDelegate : backend keypair can transfer/burn without seller signature
 *  - MetadataPointer   : on-chain metadata (name, symbol, URI)
 *  - TokenMetadata     : title, "AMSETS", IPFS preview URI
 *
 * Flow:
 *  1. Author publishes → createMintWithMetadata → 1 token minted to author.
 *  2. Buyer purchases primary → mintAccessTokenToUser (backend mints 1 to buyer).
 *  3. Seller lists → frontend sends approve tx (for old mints without PermanentDelegate).
 *  4. Buyer purchases secondary → transferTokenFromSeller (PermanentDelegate or delegated transfer).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeMetadataPointerInstruction,
  createTransferCheckedInstruction,
  createBurnInstruction,
  createMintToInstruction,
  getMintLen,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
  getPermanentDelegate,
  tokenMetadataInitialize,
} from "@solana/spl-token";
import bs58 from "bs58";

// ─── Key helpers ──────────────────────────────────────────────────────────────

function getMintAuthorityKeypair(): Keypair {
  const secret = process.env.MINT_AUTHORITY_SECRET;
  if (!secret) throw new Error("MINT_AUTHORITY_SECRET not set in backend .env");
  return Keypair.fromSecretKey(bs58.decode(secret));
}

export function getMintAuthorityPubkey(): string {
  return getMintAuthorityKeypair().publicKey.toBase58();
}

// ─── Create mint with metadata ────────────────────────────────────────────────

export interface MintMetadata {
  name:   string; // content title
  symbol: string; // e.g. "AMSETS"
  uri:    string; // IPFS/Arweave URL for content preview JSON
}

/**
 * Creates a fully-featured SPL Token-2022 mint with:
 *  - TransferFeeConfig (royalties on every secondary transfer)
 *  - PermanentDelegate (backend can move/burn tokens without seller approval)
 *  - MetadataPointer + TokenMetadata (name, symbol, URI shown in wallets)
 */
export async function createMintWithMetadata(
  royaltyBps: number,
  metadata: MintMetadata,
  connection: Connection
): Promise<string> {
  const auth   = getMintAuthorityKeypair();
  const mintKp = Keypair.generate();

  // Extension order for Token-2022:
  // MetadataPointer MUST come first in getMintLen AND in initialization.
  // PermanentDelegate and TransferFeeConfig follow.
  // InitializeMint comes LAST (after all extensions).
  const extensions = [
    ExtensionType.MetadataPointer,
    ExtensionType.PermanentDelegate,
    ExtensionType.TransferFeeConfig,
  ];
  // Allocate EXACTLY mintLen — no extra bytes.
  // tokenMetadataInitialize reallocs the account when it adds metadata TLV data.
  const mintLen  = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction();

  // 1. Create account with exactly mintLen bytes
  tx.add(
    SystemProgram.createAccount({
      fromPubkey:       auth.publicKey,
      newAccountPubkey: mintKp.publicKey,
      space:            mintLen,
      lamports,
      programId:        TOKEN_2022_PROGRAM_ID,
    })
  );

  // 2. Initialize extensions BEFORE InitializeMint (Token-2022 requirement)
  // MetadataPointer must point to the mint itself (on-chain metadata pattern)
  tx.add(
    createInitializeMetadataPointerInstruction(
      mintKp.publicKey,
      auth.publicKey,   // update authority
      mintKp.publicKey, // metadata stored in the mint account itself
      TOKEN_2022_PROGRAM_ID
    )
  );

  tx.add(
    createInitializePermanentDelegateInstruction(
      mintKp.publicKey,
      auth.publicKey,   // backend can burn/transfer anytime without seller signature
      TOKEN_2022_PROGRAM_ID
    )
  );

  tx.add(
    createInitializeTransferFeeConfigInstruction(
      mintKp.publicKey,
      auth.publicKey,   // fee config authority
      auth.publicKey,   // withdraw withheld authority
      royaltyBps,
      BigInt("18446744073709551615"), // u64::MAX — no per-transfer cap
      TOKEN_2022_PROGRAM_ID
    )
  );

  // 3. Initialize mint last (Token-2022 validates extension layout at this point)
  tx.add(
    createInitializeMintInstruction(
      mintKp.publicKey,
      0,              // 0 decimals — whole-token access passes
      auth.publicKey, // mint authority = backend keypair
      null,           // no freeze authority
      TOKEN_2022_PROGRAM_ID
    )
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash      = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer             = auth.publicKey;

  await sendAndConfirmTransaction(connection, tx, [auth, mintKp], { commitment: "confirmed" });

  // 4. Initialize on-chain token metadata
  // tokenMetadataInitialize is an async helper that sends its own transaction.
  try {
    await tokenMetadataInitialize(
      connection,
      auth,                     // payer
      mintKp.publicKey,         // mint
      auth.publicKey,           // updateAuthority
      auth,                     // mintAuthority (Signer)
      metadata.name.slice(0, 32),
      metadata.symbol.slice(0, 10),
      metadata.uri.slice(0, 200),
      [],                       // multiSigners
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    console.log(`[mint] Metadata initialized: "${metadata.name}"`);
  } catch (e: any) {
    // Metadata init can fail if space is too tight — non-fatal, token still works
    console.warn(`[mint] Metadata init warning (non-fatal): ${e?.message?.slice(0, 100)}`);
  }

  console.log(`[mint] Created mint ${mintKp.publicKey.toBase58()} with PermanentDelegate`);
  return mintKp.publicKey.toBase58();
}

/**
 * Legacy: creates a mint WITHOUT metadata (for backwards compat / admin use).
 * New content should use createMintWithMetadata.
 */
export async function createMintForExistingContent(
  royaltyBps: number,
  connection: Connection,
  metadata?: MintMetadata
): Promise<string> {
  if (metadata) {
    return createMintWithMetadata(royaltyBps, metadata, connection);
  }
  // Fallback — no metadata (for old code paths)
  const auth   = getMintAuthorityKeypair();
  const mintKp = Keypair.generate();
  // PermanentDelegate BEFORE TransferFeeConfig, InitializeMint LAST
  const extensions = [ExtensionType.PermanentDelegate, ExtensionType.TransferFeeConfig];
  const mintLen    = getMintLen(extensions);
  const lamports   = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: auth.publicKey, newAccountPubkey: mintKp.publicKey,
      space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializePermanentDelegateInstruction(mintKp.publicKey, auth.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(
      mintKp.publicKey, auth.publicKey, auth.publicKey, royaltyBps,
      BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(mintKp.publicKey, 0, auth.publicKey, null, TOKEN_2022_PROGRAM_ID)
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = auth.publicKey;
  await sendAndConfirmTransaction(connection, tx, [auth, mintKp], { commitment: "confirmed" });
  console.log(`[mint] Created mint (no metadata): ${mintKp.publicKey.toBase58()}`);
  return mintKp.publicKey.toBase58();
}

// ─── Mint 1 token to a user ───────────────────────────────────────────────────

export async function mintAccessTokenToUser(
  mintAddress: string,
  recipientWallet: string,
  connection: Connection
): Promise<string> {
  const auth      = getMintAuthorityKeypair();
  const mint      = new PublicKey(mintAddress);
  const recipient = new PublicKey(recipientWallet);
  const ata       = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);

  try {
    const acct = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (acct.amount >= 1n) {
      console.log(`[mint] ${recipient.toBase58().slice(0, 8)} already holds token`);
      return "already_minted";
    }
  } catch { /* ATA doesn't exist yet */ }

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, ata, recipient, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, ata, auth.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID)
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = auth.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [auth], { commitment: "confirmed" });
  console.log(`[mint] Minted 1 → ${recipient.toBase58().slice(0, 8)}… sig: ${sig.slice(0, 12)}…`);
  return sig;
}

export async function mintAuthorToken(
  mintAddress: string,
  authorWallet: string,
  connection: Connection
): Promise<string> {
  return mintAccessTokenToUser(mintAddress, authorWallet, connection);
}

// ─── Transfer token from seller to buyer (secondary market) ──────────────────

/**
 * Transfers 1 access token from seller to buyer.
 *
 * Strategy:
 *  1. If mint has PermanentDelegate = backend → use it to transfer directly.
 *  2. Otherwise → mint a new token to buyer + burn seller's token if possible,
 *     else just mint to buyer (graceful degradation for legacy mints).
 *
 * @returns tx signature of the transfer (or mint) transaction
 */
/**
 * Transfers an access token from seller to buyer during a secondary sale.
 *
 * WHY burn+mint instead of transferChecked:
 *   AMSETS access tokens have 0 decimals. With a 10% TransferFeeConfig,
 *   ceil(1 × 10%) = 1 — the entire token becomes a fee and the buyer receives 0.
 *   To avoid this, we never use transferChecked for secondary sales.
 *   Instead: burn seller's token (no fee) + mint new token to buyer (no fee).
 *   SOL-level royalties (author % + platform %) are collected at payment time.
 *
 * Strategy:
 *  1. Burn seller's token via PermanentDelegate (preferred — no owner sig needed).
 *  2. If no PermanentDelegate: burn via seller's delegate approval set at listing time.
 *  3. Fallback: if neither works, still mint to buyer but log a warning about seller token.
 *  After burning: mint a fresh token to buyer via backend MintAuthority.
 */
export async function transferTokenFromSeller(
  mintAddress: string,
  sellerWallet: string,
  buyerWallet: string,
  connection: Connection
): Promise<string> {
  const auth      = getMintAuthorityKeypair();
  const mint      = new PublicKey(mintAddress);
  const seller    = new PublicKey(sellerWallet);
  const sellerAta = getAssociatedTokenAddressSync(mint, seller, false, TOKEN_2022_PROGRAM_ID);

  // ─── Resolve PermanentDelegate ────────────────────────────────────────────
  let permanentDelegate: PublicKey | null = null;
  try {
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    permanentDelegate = getPermanentDelegate(mintInfo)?.delegate ?? null;
  } catch { /* non-fatal */ }

  const backendIsPD = permanentDelegate?.toBase58() === auth.publicKey.toBase58();

  // ─── Step 1: Burn seller's token ─────────────────────────────────────────
  // We NEVER use transferChecked because Token-2022 TransferFeeConfig charges
  // ceil(amount × fee_bps / 10000). With 0-decimal tokens and any fee > 0%,
  // the fee rounds up to 1 and the buyer receives 0. Burn + mint avoids fees.
  const sellerAcct = await getAccount(connection, sellerAta, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);

  if (sellerAcct && sellerAcct.amount > 0n) {
    let canBurn = false;

    if (backendIsPD) {
      canBurn = true;
      console.log(`[mint] Burning seller token via PermanentDelegate ${mintAddress.slice(0, 8)}`);
    } else if (
      sellerAcct.delegate?.toBase58() === auth.publicKey.toBase58() &&
      sellerAcct.delegatedAmount >= 1n
    ) {
      canBurn = true;
      console.log(`[mint] Burning seller token via delegate approval ${mintAddress.slice(0, 8)}`);
    }

    if (canBurn) {
      try {
        const burnTx = new Transaction();
        burnTx.add(
          createBurnInstruction(sellerAta, mint, auth.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID)
        );
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        burnTx.recentBlockhash      = blockhash;
        burnTx.lastValidBlockHeight = lastValidBlockHeight;
        burnTx.feePayer             = auth.publicKey;
        const burnSig = await sendAndConfirmTransaction(connection, burnTx, [auth], { commitment: "confirmed" });
        console.log(`[mint] Seller token burned | sig: ${burnSig.slice(0, 12)}…`);
      } catch (err: any) {
        console.error(`[mint] Burn failed: ${err?.message?.slice(0, 80)} — proceeding to mint buyer token anyway`);
      }
    } else {
      console.warn(`[mint] Cannot burn seller token (no PD, no delegate) — will mint to buyer anyway`);
    }
  } else {
    console.log(`[mint] Seller ATA empty or missing — skipping burn`);
  }

  // ─── Step 2: Mint fresh token to buyer ───────────────────────────────────
  // Always mint a new token — avoids TransferFee and works regardless of
  // whether the burn above succeeded.
  console.log(`[mint] Minting fresh access token to buyer ${buyerWallet.slice(0, 8)}`);
  const mintSig = await mintAccessTokenToUser(mintAddress, buyerWallet, connection);
  console.log(`[mint] Buyer token minted | sig: ${mintSig.slice(0, 12)}…`);

  return mintSig;
}
