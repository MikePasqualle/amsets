/**
 * Anchor / Solana helpers for the AMSETS smart contract.
 *
 * Program: amsets-registry
 * Address: B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG
 *
 * Instruction discriminators (sha256("global:<name>")[0..8]):
 *   register_content   : [170, 55, 41, 115, 252, 248, 38, 144]
 *   purchase_access_sol: [53, 118, 250, 53, 130, 186, 104, 205]
 *   set_access_mint    : [144, 141, 222, 179, 112, 54, 142, 71]
 *   initialize_vault   : [48, 191, 163, 44, 71, 129, 63, 164]
 *   mint_access_token  : computed from sha256("global:mint_access_token")[0..8]
 *
 * PDA seeds:
 *   ContentRecord : [b"content", author, content_id_bytes]
 *   AccessReceipt : [b"access", content_record_pda, buyer]
 *   FeeVault      : [b"fee_vault"]
 */

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  Connection,
  AccountInfo,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  ExtensionType,
  getMintLen,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  createMintToInstruction,
} from "@solana/spl-token";

export const AMSETS_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG"
);

// ─── Transaction helpers ──────────────────────────────────────────────────────

/**
 * Sends a transaction and waits for confirmation using the block-height strategy.
 * This avoids indefinite spinning: if the block height passes `lastValidBlockHeight`
 * without confirmation the promise rejects with a clear timeout error.
 */
async function sendAndConfirm(
  tx: Transaction,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const signature = await sendTransaction(tx, connection);
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return signature;
}

// ─── Instruction discriminators ───────────────────────────────────────────────

const REGISTER_DISCRIMINATOR = new Uint8Array([
  170, 55, 41, 115, 252, 248, 38, 144,
]);

const PURCHASE_DISCRIMINATOR = new Uint8Array([
  53, 118, 250, 53, 130, 186, 104, 205,
]);

const SET_ACCESS_MINT_DISCRIMINATOR = new Uint8Array([
  144, 141, 222, 179, 112, 54, 142, 71,
]);

// ─── Encoding helpers ────────────────────────────────────────────────────────

/** UUID string (with or without hyphens) → zero-padded 32-byte array */
export function uuidToBytes32(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < Math.min(16, Math.floor(hex.length / 2)); i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** 64-char hex SHA-256 string → 32-byte array */
export function hexToBytes32(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < Math.min(32, Math.floor(hex.length / 2)); i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Borsh string encoding: 4-byte LE length prefix + UTF-8 bytes */
function encodeString(str: string): Uint8Array {
  const encoded = new TextEncoder().encode(str);
  const result = new Uint8Array(4 + encoded.length);
  new DataView(result.buffer).setUint32(0, encoded.length, true);
  result.set(encoded, 4);
  return result;
}

/** Borsh u64 encoding: 8 little-endian bytes */
function encodeU64(val: bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, val, true);
  return new Uint8Array(buf);
}

/** Borsh u32 encoding: 4 little-endian bytes */
function encodeU32(val: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, val, true);
  return new Uint8Array(buf);
}

/** Borsh u16 encoding: 2 little-endian bytes */
function encodeU16(val: number): Uint8Array {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setUint16(0, val, true);
  return new Uint8Array(buf);
}

/** UI license string → on-chain enum variant index */
export function licenseToEnum(license: string): number {
  switch (license) {
    case "commercial":  return 1;
    case "derivative":  return 2;
    case "unlimited":   return 3;
    default:            return 0; // personal
  }
}

// ─── PDA derivation ──────────────────────────────────────────────────────────

/**
 * Derives the ContentRecord PDA.
 * Seeds: [b"content", author.publicKey, content_id_bytes]
 */
export function deriveContentRecordPda(
  authorPublicKey: PublicKey,
  contentIdBytes: Uint8Array
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("content"),
      authorPublicKey.toBuffer(),
      Buffer.from(contentIdBytes),
    ],
    AMSETS_PROGRAM_ID
  );
  return pda;
}

/**
 * Derives the AccessReceipt PDA.
 * Seeds: [b"access", content_record_pda, buyer_wallet]
 */
export function deriveAccessReceiptPda(
  contentRecordPda: PublicKey,
  buyerWallet: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("access"),
      contentRecordPda.toBuffer(),
      buyerWallet.toBuffer(),
    ],
    AMSETS_PROGRAM_ID
  );
  return pda;
}

/**
 * Derives the protocol fee vault PDA.
 * Seeds: [b"fee_vault"]
 */
export function deriveFeeVaultPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault")],
    AMSETS_PROGRAM_ID
  );
  return pda;
}

// ─── On-chain state queries ───────────────────────────────────────────────────

/**
 * Checks whether the buyer holds an AccessReceipt PDA for the given content.
 * Returns true if the account exists (i.e. purchase was completed on-chain).
 */
export async function checkHasPurchased(
  connection: Connection,
  contentRecordPda: PublicKey,
  buyerWallet: PublicKey
): Promise<boolean> {
  const receiptPda = deriveAccessReceiptPda(contentRecordPda, buyerWallet);
  const info: AccountInfo<Buffer> | null = await connection.getAccountInfo(receiptPda);
  return info !== null;
}

/**
 * Reads the on-chain ContentRecord and returns the access_mint field.
 * Returns null if the account does not exist or is malformed.
 *
 * ContentRecord memory layout (after 8-byte discriminator):
 *   content_id[32] | content_hash[32] | storage_uri(4+n) | preview_uri(4+m)
 *   | primary_author[32] | access_mint[32] | base_price[8] | payment_token[1]
 *   | license[1] | is_active[1] | bump[1]
 */
export async function readAccessMintFromChain(
  connection: Connection,
  contentRecordPda: PublicKey
): Promise<string | null> {
  const info = await connection.getAccountInfo(contentRecordPda);
  if (!info || info.data.length < 8 + 32 + 32) return null;

  try {
    // Skip 8-byte discriminator, skip content_id(32) + content_hash(32)
    let offset = 8 + 32 + 32;
    // Skip storage_uri string
    const storageLen = new DataView(info.data.buffer, info.data.byteOffset + offset, 4).getUint32(0, true);
    offset += 4 + storageLen;
    // Skip preview_uri string
    const previewLen = new DataView(info.data.buffer, info.data.byteOffset + offset, 4).getUint32(0, true);
    offset += 4 + previewLen;
    // Skip primary_author[32]
    offset += 32;
    // Read access_mint[32]
    const mintBytes = info.data.slice(offset, offset + 32);
    const mint = new PublicKey(mintBytes);
    if (mint.equals(PublicKey.default)) return null;
    return mint.toBase58();
  } catch {
    return null;
  }
}

// ─── Instruction builders ─────────────────────────────────────────────────────

export interface RegisterContentArgs {
  contentId:    Uint8Array;   // 32 bytes (from UUID)
  contentHash:  Uint8Array;   // 32 bytes (SHA-256)
  storageUri:   string;       // "ar://{txId}" or "ar://pending_{id}"
  previewUri:   string;       // "ipfs://{cid}"
  basePrice:    bigint;       // lamports, must be > 0
  paymentToken: 0 | 1;       // 0 = SOL, 1 = USDC
  license:      0 | 1 | 2 | 3; // Personal / Commercial / Derivative / Unlimited
  totalSupply:  number;       // max tokens for sale (default 1)
  royaltyBps:   number;       // royalty in basis points (0–5000, default 1000 = 10%)
}

/**
 * Builds the complete Borsh-serialized instruction data for `register_content`.
 */
export function buildRegisterContentData(args: RegisterContentArgs): Uint8Array {
  const storageBytes  = encodeString(args.storageUri);
  const previewBytes  = encodeString(args.previewUri);
  const priceBytes    = encodeU64(args.basePrice);
  const supplyBytes   = encodeU32(args.totalSupply);
  const royaltyBytes  = encodeU16(args.royaltyBps);

  const total =
    8 + 32 + 32 + storageBytes.length + previewBytes.length + 8 + 1 + 1 + 4 + 2;
  const result = new Uint8Array(total);
  let offset = 0;

  result.set(REGISTER_DISCRIMINATOR, offset); offset += 8;
  result.set(args.contentId, offset);          offset += 32;
  result.set(args.contentHash, offset);        offset += 32;
  result.set(storageBytes, offset);            offset += storageBytes.length;
  result.set(previewBytes, offset);            offset += previewBytes.length;
  result.set(priceBytes, offset);              offset += 8;
  result[offset] = args.paymentToken;          offset += 1;
  result[offset] = args.license;               offset += 1;
  result.set(supplyBytes, offset);             offset += 4;
  result.set(royaltyBytes, offset);

  return result;
}

/**
 * Builds instruction data for `purchase_access_sol`.
 * The instruction has no extra args beyond accounts.
 */
function buildPurchaseAccessSolData(): Uint8Array {
  return Buffer.from(PURCHASE_DISCRIMINATOR);
}

/**
 * Builds instruction data for `set_access_mint`.
 * The instruction has no extra args beyond accounts.
 */
function buildSetAccessMintData(): Uint8Array {
  return Buffer.from(SET_ACCESS_MINT_DISCRIMINATOR);
}

// ─── High-level transaction helpers ──────────────────────────────────────────

export interface PublishOnChainParams {
  /** ContentId as returned by the backend (32-char hex string) */
  contentId: string;
  /** SHA-256 hex hash of the original file */
  contentHash: string;
  /** Storage URI — real Arweave or ar://pending_... placeholder */
  storageUri: string;
  /** IPFS preview CID */
  previewCid: string;
  /** Price in SOL (human-readable, e.g. "0.1") */
  priceSol: string;
  /** License string from the UI */
  license: string;
  /** Number of access tokens for sale (default 1) */
  totalSupply?: number;
  /** Royalty in basis points, 0–5000 (default 1000 = 10%) */
  royaltyBps?: number;
}

export interface PublishOnChainResult {
  signature: string;
  pdaAddress: string;
}

/**
 * Builds, signs and sends the Anchor `register_content` transaction.
 * Returns the transaction signature and ContentRecord PDA address.
 *
 * Throws a descriptive error if the program is not yet deployed on the cluster,
 * so the caller can show a meaningful "saved as draft" message instead of
 * the generic Phantom "Unexpected error".
 */
export async function publishOnChain(
  params: PublishOnChainParams,
  authorPublicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<PublishOnChainResult> {
  // Guard: check that the program is deployed before asking Phantom to sign.
  // This avoids the confusing "Unexpected error" / "simulation failed" Phantom dialog.
  const programInfo = await connection.getAccountInfo(AMSETS_PROGRAM_ID);
  if (!programInfo || !programInfo.executable) {
    throw new Error(
      "Smart contract is not yet deployed on this network. " +
      "Content saved as Draft — on-chain registration pending deployment."
    );
  }

  const contentIdBytes   = uuidToBytes32(params.contentId);
  const contentHashBytes = hexToBytes32(params.contentHash);

  const pda = deriveContentRecordPda(authorPublicKey, contentIdBytes);

  const basePrice = BigInt(
    Math.max(1, Math.round(parseFloat(params.priceSol) * 1_000_000_000))
  );

  const ixData = buildRegisterContentData({
    contentId:    contentIdBytes,
    contentHash:  contentHashBytes,
    storageUri:   params.storageUri,
    previewUri:   `ipfs://${params.previewCid}`,
    basePrice,
    paymentToken: 0,
    license:      licenseToEnum(params.license) as 0 | 1 | 2 | 3,
    totalSupply:  params.totalSupply ?? 1,
    royaltyBps:   params.royaltyBps ?? 1000,
  });

  const ix = new TransactionInstruction({
    programId: AMSETS_PROGRAM_ID,
    keys: [
      { pubkey: authorPublicKey,         isSigner: true,  isWritable: true },
      { pubkey: pda,                     isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authorPublicKey;

  const signature = await sendAndConfirm(tx, sendTransaction, connection);
  return { signature, pdaAddress: pda.toBase58() };
}

export interface PurchaseAccessParams {
  /** ContentRecord PDA address (as returned by publishOnChain) */
  contentRecordPda: string;
  /** Author's wallet address (must match content_record.primary_author) */
  authorWallet: string;
}

export interface PurchaseAccessResult {
  signature: string;
  receiptPda: string;
}

/**
 * Builds, signs and sends the `purchase_access_sol` transaction.
 * Creates an AccessReceipt PDA and distributes payment:
 *   97.5% → author, 2.5% → fee vault.
 */
export async function purchaseAccess(
  params: PurchaseAccessParams,
  buyerPublicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<PurchaseAccessResult> {
  const contentRecordPda = new PublicKey(params.contentRecordPda);
  const authorWallet     = new PublicKey(params.authorWallet);
  const feeVaultPda      = deriveFeeVaultPda();
  const receiptPda       = deriveAccessReceiptPda(contentRecordPda, buyerPublicKey);

  const ixData = buildPurchaseAccessSolData();

  const ix = new TransactionInstruction({
    programId: AMSETS_PROGRAM_ID,
    keys: [
      { pubkey: buyerPublicKey,          isSigner: true,  isWritable: true },
      { pubkey: contentRecordPda,        isSigner: false, isWritable: true },
      { pubkey: receiptPda,              isSigner: false, isWritable: true },
      { pubkey: authorWallet,            isSigner: false, isWritable: true },
      { pubkey: feeVaultPda,             isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = buyerPublicKey;

  const signature = await sendAndConfirm(tx, sendTransaction, connection);
  return { signature, receiptPda: receiptPda.toBase58() };
}

/**
 * Links a pre-created SPL access mint to the ContentRecord on-chain.
 * Called after `publishOnChain` + SPL mint creation.
 */
export async function setAccessMint(
  contentRecordPda: PublicKey,
  accessMintPubkey: PublicKey,
  authorPublicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<string> {
  const ixData = buildSetAccessMintData();

  const ix = new TransactionInstruction({
    programId: AMSETS_PROGRAM_ID,
    keys: [
      { pubkey: authorPublicKey,   isSigner: true,  isWritable: true },  // fee payer + signer
      { pubkey: contentRecordPda,  isSigner: false, isWritable: true },
      { pubkey: accessMintPubkey,  isSigner: false, isWritable: false },
      { pubkey: authorPublicKey,   isSigner: false, isWritable: false },  // primary_author (has_one constraint)
    ],
    data: Buffer.from(ixData),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authorPublicKey;

  return await sendAndConfirm(tx, sendTransaction, connection);
}

/**
 * Funds the fee vault PDA via a plain system transfer.
 * Calls `initialize_vault` instruction to ensure the FeeVault PDA exists and has
 * enough lamports to be rent-exempt. Safe to call multiple times (idempotent
 * — the Rust instruction exits early when lamports are sufficient).
 */
export async function ensureFeeVaultFunded(
  payerPublicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<void> {
  const feeVaultPda = deriveFeeVaultPda();
  const info = await connection.getAccountInfo(feeVaultPda);
  const MIN_RENT = 890880; // ~rent-exempt for 0-byte account

  if (info && info.lamports >= MIN_RENT) return; // already funded, nothing to do

  // initialize_vault discriminator (sha256("global:initialize_vault")[0..8])
  const disc = new Uint8Array([48, 191, 163, 44, 71, 129, 63, 164]);
  // Fund with 0.01 SOL (will be capped to what's needed by the program)
  const lamports = encodeU64(BigInt(10_000_000));
  const data = new Uint8Array([...disc, ...lamports]);

  const ix = new TransactionInstruction({
    programId: AMSETS_PROGRAM_ID,
    keys: [
      { pubkey: payerPublicKey, isSigner: true,  isWritable: true  },
      { pubkey: feeVaultPda,    isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = payerPublicKey;

  await sendAndConfirm(tx, sendTransaction, connection);
}

// ─── SPL Token-2022 helpers ───────────────────────────────────────────────────

/**
 * Creates a new SPL Token-2022 mint with the TransferFee extension configured
 * for royalty collection on resale.
 *
 * The MINT AUTHORITY is set to the backend's public key (NEXT_PUBLIC_MINT_AUTHORITY_PUBKEY)
 * so the backend can automatically mint access tokens to buyers without requiring
 * the author to be online. The author still pays the rent for the mint account.
 *
 * @param royaltyBps   Basis points for the transfer fee (0–5000).
 */
export async function createMintForContent(
  authorPublicKey: PublicKey,
  royaltyBps: number,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<{ mintKeypair: Keypair; signature: string }> {
  const mintKeypair  = Keypair.generate();
  const extensions   = [ExtensionType.TransferFeeConfig];
  const mintLen      = getMintLen(extensions);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  // Use the backend's public key as mint authority so it can auto-mint access
  // tokens to buyers after purchase without the author's signature.
  const mintAuthorityStr = process.env.NEXT_PUBLIC_MINT_AUTHORITY_PUBKEY;
  const mintAuthority    = mintAuthorityStr
    ? new PublicKey(mintAuthorityStr)
    : authorPublicKey; // fallback to author (single-player mode)

  // Fee rate in basis points (0-10000). royaltyBps is 0-5000 so fits fine.
  const feeBasisPoints   = royaltyBps;
  const maximumFee       = BigInt("18446744073709551615"); // u64::MAX

  const tx = new Transaction().add(
    // 1. Create the mint account (author pays rent)
    SystemProgram.createAccount({
      fromPubkey:  authorPublicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space:       mintLen,
      lamports:    mintLamports,
      programId:   TOKEN_2022_PROGRAM_ID,
    }),
    // 2. Initialize TransferFeeConfig extension (author controls fee rate)
    createInitializeTransferFeeConfigInstruction(
      mintKeypair.publicKey,
      authorPublicKey, // transfer fee config authority
      authorPublicKey, // withdraw withheld tokens authority
      feeBasisPoints,
      maximumFee,
      TOKEN_2022_PROGRAM_ID
    ),
    // 3. Initialize the mint itself — backend is the mint authority
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      0,              // decimals (whole tokens only)
      mintAuthority,  // backend keypair can mint without author signature
      null,           // freeze authority (none)
      TOKEN_2022_PROGRAM_ID
    )
  );

  tx.feePayer = authorPublicKey;
  tx.partialSign(mintKeypair);

  const signature = await sendAndConfirm(tx, sendTransaction, connection);
  return { mintKeypair, signature };
}

/**
 * Mints 1 author token (authorship proof) to the author's associated token account.
 * This is the "1 fixed author token" that the author always holds.
 */
export async function mintAuthorToken(
  mintPublicKey: PublicKey,
  authorPublicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<{ ata: string; signature: string }> {
  const ata = getAssociatedTokenAddressSync(
    mintPublicKey,
    authorPublicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      authorPublicKey, // payer
      ata,
      authorPublicKey,
      mintPublicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    createMintToInstruction(
      mintPublicKey,
      ata,
      authorPublicKey, // mint authority
      1,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  tx.feePayer = authorPublicKey;

  const signature = await sendAndConfirm(tx, sendTransaction, connection);
  return { ata: ata.toBase58(), signature };
}

// Discriminator for mint_access_token instruction
// sha256("global:mint_access_token")[0..8] — to be computed at runtime on first use
const MINT_ACCESS_TOKEN_DISCRIMINATOR = new Uint8Array([
  107, 67, 1, 150, 100, 134, 84, 149,
]);

/**
 * Calls the on-chain `mint_access_token` checkpoint instruction.
 * This validates the AccessReceipt PDA exists and emits an event — the actual
 * SPL token minting to the buyer happens client-side via mintBuyerAccessToken.
 */
export async function callMintAccessTokenCheckpoint(
  contentRecordPda: PublicKey,
  buyerPublicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<string> {
  const receiptPda = deriveAccessReceiptPda(contentRecordPda, buyerPublicKey);

  const ix = new TransactionInstruction({
    programId: AMSETS_PROGRAM_ID,
    keys: [
      { pubkey: buyerPublicKey,   isSigner: true,  isWritable: true },
      { pubkey: contentRecordPda, isSigner: false, isWritable: false },
      { pubkey: receiptPda,       isSigner: false, isWritable: false },
    ],
    data: Buffer.from(MINT_ACCESS_TOKEN_DISCRIMINATOR),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = buyerPublicKey;

  const signature = await sendAndConfirm(tx, sendTransaction, connection);
  return signature;
}

/**
 * Mints 1 buyer access token (SPL Token-2022) to the buyer's ATA.
 * The mint authority is the author's wallet — this must be called by the author
 * OR the mint authority must have been delegated/transferred.
 *
 * In the current setup, we call this from the author's side after confirming
 * the purchase. In production this would be automated via a Helius webhook.
 *
 * @param mintPublicKey  The SPL Token-2022 mint address linked to the content
 * @param buyerPublicKey Recipient of the access token
 * @param authorPublicKey Mint authority (author)
 */
export async function mintBuyerAccessToken(
  mintPublicKey: PublicKey,
  buyerPublicKey: PublicKey,
  authorPublicKey: PublicKey,
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>,
  connection: Connection
): Promise<{ ata: string; signature: string }> {
  const ata = getAssociatedTokenAddressSync(
    mintPublicKey,
    buyerPublicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      authorPublicKey, // payer
      ata,
      buyerPublicKey,
      mintPublicKey,
      TOKEN_2022_PROGRAM_ID
    ),
    createMintToInstruction(
      mintPublicKey,
      ata,
      authorPublicKey, // mint authority = author
      1,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  tx.feePayer = authorPublicKey;

  const signature = await sendAndConfirm(tx, sendTransaction, connection);
  return { ata: ata.toBase58(), signature };
}

// ─── Token balance check (canonical access gate) ──────────────────────────────

/**
 * Returns the total SPL Token-2022 balance for `ownerPublicKey` for a given
 * `mintAddress`.  Returns 0 if the owner has no ATA or the mint doesn't exist.
 *
 * Used as the primary access gate: if balance > 0 the user may view content.
 */
export async function checkTokenBalance(
  connection: Connection,
  mintAddress: string,
  ownerPublicKey: PublicKey
): Promise<number> {
  try {
    const mint = new PublicKey(mintAddress);
    const accounts = await connection.getParsedTokenAccountsByOwner(
      ownerPublicKey,
      { mint, programId: TOKEN_2022_PROGRAM_ID }
    );
    return accounts.value.reduce((sum, { account }) => {
      const amount = account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
      return sum + amount;
    }, 0);
  } catch {
    return 0;
  }
}

// ─── Re-exports for convenience ───────────────────────────────────────────────

export { LAMPORTS_PER_SOL, TOKEN_2022_PROGRAM_ID };
