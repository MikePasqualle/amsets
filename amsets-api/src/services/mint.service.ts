/**
 * Mint Service — SPL Token-2022 operations for AMSETS.
 *
 * Two-token model per content item:
 *  - Author NFT (1-of-1, no TransferFeeConfig): proves authorship, royalty rights.
 *  - Access Token  (user-defined supply, no TransferFeeConfig): grants content viewing.
 *
 * Both mints have PermanentDelegate (backend keypair) so the backend can
 * move/burn tokens without requiring the owner's signature.
 *
 * Royalties are collected in SOL at transaction time via the smart contract,
 * NOT via token transfer fees (TransferFeeConfig removed from all new mints).
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
  createInitializePermanentDelegateInstruction,
  createInitializeMetadataPointerInstruction,
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

// ─── Metadata type ────────────────────────────────────────────────────────────

export interface MintMetadata {
  name:   string; // content title
  symbol: string; // e.g. "AMSETS"
  uri:    string; // IPFS preview URI (for wallet display)
}

// ─── Internal: create a SPL Token-2022 mint with no transfer fee ─────────────

async function createToken2022Mint(
  metadata: MintMetadata,
  connection: Connection
): Promise<string> {
  const auth   = getMintAuthorityKeypair();
  const mintKp = Keypair.generate();

  // Extensions: MetadataPointer must be first, then PermanentDelegate.
  // NO TransferFeeConfig — royalties collected in SOL at purchase time.
  const extensions = [
    ExtensionType.MetadataPointer,
    ExtensionType.PermanentDelegate,
  ];
  const mintLen  = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction();

  // 1. Create mint account
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
      auth.publicKey,   // backend can burn/transfer without owner signature
      TOKEN_2022_PROGRAM_ID
    )
  );

  // 3. Initialize mint (0 decimals — whole-token access passes)
  tx.add(
    createInitializeMintInstruction(
      mintKp.publicKey,
      0,              // 0 decimals
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

  // 4. Initialize on-chain token metadata (reallocs the account with TLV data)
  try {
    await tokenMetadataInitialize(
      connection,
      auth,
      mintKp.publicKey,
      auth.publicKey,
      auth,
      metadata.name.slice(0, 32),
      metadata.symbol.slice(0, 10),
      metadata.uri.slice(0, 200),
      [],
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    console.log(`[mint] Metadata initialized: "${metadata.name}"`);
  } catch (e: any) {
    // Non-fatal: wallet still receives the token, just without rich metadata
    console.warn(`[mint] Metadata init warning (non-fatal): ${e?.message?.slice(0, 100)}`);
  }

  return mintKp.publicKey.toBase58();
}

// ─── Create Access Token mint ─────────────────────────────────────────────────

/**
 * Creates the access token mint for content.
 * No TransferFeeConfig — royalties are collected in SOL on-chain.
 * Has PermanentDelegate so backend can move tokens for escrow and burn for resale.
 */
export async function createMintWithMetadata(
  _royaltyBps: number,   // kept for API compatibility — not used for fee config
  metadata: MintMetadata,
  connection: Connection
): Promise<string> {
  const address = await createToken2022Mint(metadata, connection);
  console.log(`[mint] Created access token mint ${address}`);
  return address;
}

/**
 * Legacy alias — kept for backwards compatibility.
 */
export async function createMintForExistingContent(
  royaltyBps: number,
  connection: Connection,
  metadata?: MintMetadata
): Promise<string> {
  if (metadata) return createMintWithMetadata(royaltyBps, metadata, connection);
  // Fallback — no metadata (old code paths)
  return createToken2022Mint({ name: "AMSETS", symbol: "AMSETS", uri: "" }, connection);
}

// ─── Create Author NFT mint ───────────────────────────────────────────────────

/**
 * Creates a 1-of-1 Author NFT mint for a content item.
 * This is a separate mint from the access token mint.
 * The holder of this NFT receives all royalty payments.
 */
export async function createAuthorNftMint(
  metadata: MintMetadata,
  connection: Connection
): Promise<string> {
  const address = await createToken2022Mint(
    {
      name:   `${metadata.name} — Author`,
      symbol: "AUT",
      uri:    metadata.uri,
    },
    connection
  );
  console.log(`[mint] Created Author NFT mint ${address}`);
  return address;
}

// ─── Mint tokens ──────────────────────────────────────────────────────────────

/**
 * Mints 1 token to a recipient wallet. Idempotent — skips if recipient already has ≥1.
 */
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
  } catch { /* ATA doesn't exist yet — proceed to mint */ }

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, ata, recipient, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, ata, auth.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID)
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = auth.publicKey;

  const sig = await sendAndConfirmTransaction(connection, tx, [auth], { commitment: "confirmed" });
  console.log(`[mint] Minted 1 token → ${recipient.toBase58().slice(0, 8)}… sig: ${sig.slice(0, 12)}…`);
  return sig;
}

/**
 * Mints 1 Author NFT to the content author's wallet.
 * Idempotent — skips if the author already holds the NFT.
 */
export async function mintAuthorNft(
  authorNftMintAddress: string,
  authorWallet: string,
  connection: Connection
): Promise<string> {
  console.log(`[mint] Minting Author NFT to ${authorWallet.slice(0, 8)}…`);
  return mintAccessTokenToUser(authorNftMintAddress, authorWallet, connection);
}

/** Alias kept for backward compatibility */
export async function mintAuthorToken(
  mintAddress: string,
  authorWallet: string,
  connection: Connection
): Promise<string> {
  return mintAccessTokenToUser(mintAddress, authorWallet, connection);
}

// ─── Resolve Author NFT holder ────────────────────────────────────────────────

/**
 * Finds the current holder of the 1-of-1 Author NFT.
 * Queries Helius DAS API first (most efficient), falls back to RPC scan.
 * Returns the holder's wallet address, or null if not found.
 */
export async function resolveAuthorNftHolder(
  authorNftMintAddress: string,
  connection: Connection
): Promise<string | null> {
  const heliusKey = process.env.HELIUS_API_KEY;
  const cluster   = process.env.SOLANA_CLUSTER ?? "devnet";

  // Try Helius DAS getTokenAccounts first
  if (heliusKey) {
    try {
      const rpcUrl =
        cluster === "mainnet-beta"
          ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
          : `https://devnet.helius-rpc.com/?api-key=${heliusKey}`;

      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id:      "amsets-royalty-resolve",
          method:  "getTokenAccounts",
          params: {
            mint:  authorNftMintAddress,
            limit: 10,
          },
        }),
      });

      if (resp.ok) {
        const json: any = await resp.json();
        const accounts: any[] = json?.result?.token_accounts ?? [];
        // Find account with amount >= 1
        const holder = accounts.find((a: any) => Number(a.amount) >= 1);
        if (holder?.owner) {
          console.log(`[mint] Author NFT holder resolved via DAS: ${holder.owner.slice(0, 8)}…`);
          return holder.owner as string;
        }
      }
    } catch (e: any) {
      console.warn(`[mint] DAS lookup failed: ${e?.message?.slice(0, 60)} — falling back to RPC`);
    }
  }

  // Fallback: RPC getParsedTokenAccountsByOwner is too slow for unknown owners.
  // Use getTokenLargestAccounts to find who holds the mint.
  try {
    const mint    = new PublicKey(authorNftMintAddress);
    const largest = await connection.getTokenLargestAccounts(mint, "confirmed");
    if (!largest.value.length) return null;

    // The Author NFT has supply of 1 — the largest account is the holder
    const holderAta = largest.value[0].address;
    const acctInfo  = await connection.getParsedAccountInfo(holderAta, "confirmed");
    const parsed    = (acctInfo.value?.data as any)?.parsed?.info;
    const owner: string | undefined = parsed?.owner;
    if (owner) {
      console.log(`[mint] Author NFT holder resolved via RPC: ${owner.slice(0, 8)}…`);
      return owner;
    }
  } catch (e: any) {
    console.warn(`[mint] RPC fallback failed: ${e?.message?.slice(0, 60)}`);
  }

  return null;
}

// ─── Escrow helpers ───────────────────────────────────────────────────────────

/**
 * Moves a seller's access token to the backend escrow ATA.
 * Uses PermanentDelegate so no seller signature is needed.
 * Called when a listing is created.
 * Returns the escrow ATA address.
 */
export async function moveTokenToEscrow(
  mintAddress: string,
  sellerWallet: string,
  connection: Connection
): Promise<{ escrowAta: string; burnSig: string }> {
  const auth      = getMintAuthorityKeypair();
  const mint      = new PublicKey(mintAddress);
  const seller    = new PublicKey(sellerWallet);
  const sellerAta = getAssociatedTokenAddressSync(mint, seller, false, TOKEN_2022_PROGRAM_ID);
  const escrowAta = getAssociatedTokenAddressSync(mint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // Check seller actually has the token
  const sellerAcct = await getAccount(connection, sellerAta, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
  if (!sellerAcct || sellerAcct.amount < 1n) {
    throw new Error(`Seller ${sellerWallet.slice(0, 8)} does not hold an access token for mint ${mintAddress.slice(0, 8)}`);
  }

  const tx = new Transaction();

  // Create escrow ATA if it doesn't exist
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      auth.publicKey, escrowAta, auth.publicKey, mint, TOKEN_2022_PROGRAM_ID
    )
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash      = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer             = auth.publicKey;

  await sendAndConfirmTransaction(connection, tx, [auth], { commitment: "confirmed" });

  // Burn from seller + mint to escrow (avoids TransferFeeConfig issues)
  const burnTx = new Transaction();
  burnTx.add(
    createBurnInstruction(sellerAta, mint, auth.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID)
  );

  const { blockhash: bh2, lastValidBlockHeight: lbh2 } = await connection.getLatestBlockhash("confirmed");
  burnTx.recentBlockhash      = bh2;
  burnTx.lastValidBlockHeight = lbh2;
  burnTx.feePayer             = auth.publicKey;

  const burnSig = await sendAndConfirmTransaction(connection, burnTx, [auth], { commitment: "confirmed" });
  console.log(`[mint] Seller token moved to escrow | burn sig: ${burnSig.slice(0, 12)}…`);

  // Mint fresh token to escrow
  await mintAccessTokenToUser(mintAddress, auth.publicKey.toBase58(), connection);
  console.log(`[mint] Minted replacement token to escrow ${escrowAta.toBase58().slice(0, 8)}…`);

  return { escrowAta: escrowAta.toBase58(), burnSig };
}

/**
 * Moves the escrowed access token from escrow ATA to the buyer.
 * Burns the escrow token + mints fresh to buyer (avoids TransferFeeConfig).
 * Called after execute_sale on-chain transaction confirms.
 */
export async function moveTokenFromEscrow(
  mintAddress: string,
  buyerWallet: string,
  connection: Connection
): Promise<string> {
  const auth      = getMintAuthorityKeypair();
  const mint      = new PublicKey(mintAddress);
  const escrowAta = getAssociatedTokenAddressSync(mint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID);

  // Burn from escrow
  const escrowAcct = await getAccount(connection, escrowAta, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
  if (escrowAcct && escrowAcct.amount >= 1n) {
    const burnTx = new Transaction();
    burnTx.add(
      createBurnInstruction(escrowAta, mint, auth.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID)
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    burnTx.recentBlockhash      = blockhash;
    burnTx.lastValidBlockHeight = lastValidBlockHeight;
    burnTx.feePayer             = auth.publicKey;

    const burnSig = await sendAndConfirmTransaction(connection, burnTx, [auth], { commitment: "confirmed" });
    console.log(`[mint] Escrow token burned | sig: ${burnSig.slice(0, 12)}…`);
  } else {
    console.warn(`[mint] Escrow ATA empty or missing — will still mint to buyer`);
  }

  // Mint fresh token to buyer
  const mintSig = await mintAccessTokenToUser(mintAddress, buyerWallet, connection);
  console.log(`[mint] Token delivered to buyer ${buyerWallet.slice(0, 8)}… | sig: ${mintSig.slice(0, 12)}…`);
  return mintSig;
}

/**
 * Returns an escrowed token back to the seller when a listing is cancelled.
 * Burns from escrow + mints fresh to seller.
 */
export async function returnTokenFromEscrow(
  mintAddress: string,
  sellerWallet: string,
  connection: Connection
): Promise<string> {
  console.log(`[mint] Returning escrowed token to seller ${sellerWallet.slice(0, 8)}…`);
  return moveTokenFromEscrow(mintAddress, sellerWallet, connection);
}

// ─── Legacy: secondary transfer (kept for backward compatibility) ──────────────

/**
 * @deprecated Use moveTokenFromEscrow for new listings.
 * Kept for backward compatibility with old listings that used delegate approval.
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

  let permanentDelegate: PublicKey | null = null;
  try {
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    permanentDelegate = getPermanentDelegate(mintInfo)?.delegate ?? null;
  } catch { /* non-fatal */ }

  const backendIsPD = permanentDelegate?.toBase58() === auth.publicKey.toBase58();
  const sellerAcct  = await getAccount(connection, sellerAta, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);

  if (sellerAcct && sellerAcct.amount > 0n) {
    let canBurn = backendIsPD || (
      sellerAcct.delegate?.toBase58() === auth.publicKey.toBase58() &&
      sellerAcct.delegatedAmount >= 1n
    );

    if (canBurn) {
      try {
        const burnTx = new Transaction();
        burnTx.add(createBurnInstruction(sellerAta, mint, auth.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID));
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        burnTx.recentBlockhash = blockhash; burnTx.lastValidBlockHeight = lastValidBlockHeight;
        burnTx.feePayer = auth.publicKey;
        const sig = await sendAndConfirmTransaction(connection, burnTx, [auth], { commitment: "confirmed" });
        console.log(`[mint] Legacy: seller token burned | sig: ${sig.slice(0, 12)}…`);
      } catch (err: any) {
        console.error(`[mint] Legacy burn failed: ${err?.message?.slice(0, 80)}`);
      }
    }
  }

  return mintAccessTokenToUser(mintAddress, buyerWallet, connection);
}
