/**
 * Helius API service for AMSETS.
 *
 * Helius provides enhanced Solana RPC with:
 *   - Program account indexing (fetch all PDA accounts for a program)
 *   - Webhook notifications on new transactions
 *   - Digital Asset Standard (DAS) API for NFTs
 *
 * For AMSETS, we use Helius to:
 *   1. Fetch all ContentRecord PDAs from the amsets-registry program
 *   2. Parse and deserialize the on-chain data (Borsh format)
 *   3. Return structured content metadata for the marketplace
 *
 * This makes PostgreSQL a cache/fallback rather than the primary source.
 *
 * Borsh layout of ContentRecord (after 8-byte discriminator):
 *   content_id[32] | content_hash[32]
 *   | storage_uri(4+n) | preview_uri(4+m)
 *   | primary_author[32] | access_mint[32] | author_nft_mint[32]
 *   | base_price[8 LE u64] | payment_token[1] | license[1]
 *   | is_active[1] | bump[1]
 *   | total_supply[4 LE u32] | available_supply[4 LE u32]
 *   | royalty_bps[2 LE u16] | min_royalty_lamports[8 LE u64]
 *
 * Borsh layout of RegistryState (after 8-byte discriminator):
 *   total_content[8] | total_purchases[8] | total_secondary_sales[8]
 *   | total_sol_volume[8] | bump[1]
 */

const AMSETS_PROGRAM_ID = process.env.PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG";

// ContentRecord account discriminator = sha256("account:ContentRecord")[0..8]
// Pre-computed: [22, 30, 119, 161, 251, 124, 237, 60]
const CONTENT_RECORD_DISCRIMINATOR = [22, 30, 119, 161, 251, 124, 237, 60];

export interface OnChainContentRecord {
  pdaAddress: string;
  contentId: string;        // 32-byte hex (first 16 = DB UUID)
  contentHash: string;      // 32-byte hex
  storageUri: string;       // "livepeer://{playbackId}" or "ar://{txId}"
  previewUri: string;       // "ipfs://{cid}"
  primaryAuthor: string;    // base58 pubkey
  accessMint: string;       // base58 pubkey or "pending"
  authorNftMint: string;    // base58 pubkey or "pending"
  basePrice: bigint;        // lamports
  paymentToken: "SOL" | "USDC";
  license: "personal" | "commercial" | "derivative" | "unlimited";
  isActive: boolean;
  totalSupply: number;           // maximum access tokens
  availableSupply: number;       // remaining tokens (decremented on purchase)
  royaltyBps: number;            // royalty in basis points (0–5000)
  minRoyaltyLamports: bigint;    // absolute floor per secondary sale; 0 = percentage-only
}

export interface OnChainRegistryState {
  totalContent: bigint;
  totalPurchases: bigint;
  totalSecondarySales: bigint;
  totalSolVolume: bigint;   // lamports
}

const LICENSE_MAP = ["personal", "commercial", "derivative", "unlimited"] as const;
const TOKEN_MAP   = ["SOL", "USDC"] as const;

// ─── Borsh deserialization helpers ────────────────────────────────────────────

function readString(data: Buffer, offset: number): [string, number] {
  const len = data.readUInt32LE(offset);
  offset += 4;
  const str = data.slice(offset, offset + len).toString("utf-8");
  return [str, offset + len];
}

function readPublicKey(data: Buffer, offset: number): [string, number] {
  const bytes = data.slice(offset, offset + 32);
  // Convert 32-byte buffer to base58
  return [toBase58(bytes), offset + 32];
}

/**
 * Deserialize a raw ContentRecord account buffer into a structured object.
 * Returns null if the buffer is too short or malformed.
 *
 * Full Borsh layout (after 8-byte discriminator):
 *   content_id[32] | content_hash[32]
 *   | storage_uri(4+n) | preview_uri(4+m)
 *   | primary_author[32] | access_mint[32] | author_nft_mint[32]
 *   | base_price[8] | payment_token[1] | license[1] | is_active[1] | bump[1]
 *   | total_supply[4] | available_supply[4] | royalty_bps[2] | min_royalty_lamports[8]
 */
export function deserializeContentRecord(
  pdaAddress: string,
  data: Buffer
): OnChainContentRecord | null {
  try {
    // Minimum size check: discriminator(8) + content_id(32) + content_hash(32)
    if (data.length < 8 + 32 + 32) return null;

    let offset = 8; // skip 8-byte discriminator

    // content_id[32] — on-chain the UUID (16 bytes) is padded to 32 bytes with zeros.
    // We only take the first 16 bytes so the hex matches the 32-char DB content ID.
    const contentIdBytes = data.slice(offset, offset + 32);
    const contentId      = contentIdBytes.slice(0, 16).toString("hex");
    offset += 32;

    // content_hash[32]
    const contentHashBytes = data.slice(offset, offset + 32);
    const contentHash      = contentHashBytes.toString("hex");
    offset += 32;

    // storage_uri (4-byte length prefix + UTF-8 string)
    let storageUri: string;
    [storageUri, offset] = readString(data, offset);

    // preview_uri (4-byte length prefix + UTF-8 string)
    let previewUri: string;
    [previewUri, offset] = readString(data, offset);

    // primary_author[32]
    let primaryAuthor: string;
    [primaryAuthor, offset] = readPublicKey(data, offset);

    // access_mint[32]
    const mintBytes  = data.slice(offset, offset + 32);
    const isDefault  = mintBytes.every((b) => b === 0);
    const accessMint = isDefault ? "pending" : toBase58(mintBytes);
    offset += 32;

    // author_nft_mint[32]
    const nftMintBytes   = data.slice(offset, offset + 32);
    const isNftDefault   = nftMintBytes.every((b) => b === 0);
    const authorNftMint  = isNftDefault ? "pending" : toBase58(nftMintBytes);
    offset += 32;

    // base_price[8 LE u64]
    const basePrice = data.readBigUInt64LE(offset);
    offset += 8;

    // payment_token[1]
    const paymentTokenIdx = data[offset] ?? 0;
    offset += 1;

    // license[1]
    const licenseIdx = data[offset] ?? 0;
    offset += 1;

    // is_active[1]
    const isActive = data[offset] === 1;
    offset += 1;

    // bump[1] — skip
    offset += 1;

    // total_supply[4 LE u32]
    const totalSupply = data.length > offset + 3 ? data.readUInt32LE(offset) : 0;
    offset += 4;

    // available_supply[4 LE u32]
    const availableSupply = data.length > offset + 3 ? data.readUInt32LE(offset) : 0;
    offset += 4;

    // royalty_bps[2 LE u16]
    const royaltyBps = data.length > offset + 1 ? data.readUInt16LE(offset) : 0;
    offset += 2;

    // min_royalty_lamports[8 LE u64] — 0 if account was created before this field was added
    const minRoyaltyLamports = data.length > offset + 7 ? data.readBigUInt64LE(offset) : 0n;

    return {
      pdaAddress,
      contentId,
      contentHash,
      storageUri,
      previewUri,
      primaryAuthor,
      accessMint,
      authorNftMint,
      basePrice,
      paymentToken: TOKEN_MAP[paymentTokenIdx] ?? "SOL",
      license:      LICENSE_MAP[licenseIdx]    ?? "personal",
      isActive,
      totalSupply,
      availableSupply,
      royaltyBps,
      minRoyaltyLamports,
    };
  } catch {
    return null;
  }
}

// ─── Helius API calls ─────────────────────────────────────────────────────────

function getHeliusApiKey(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY not configured");
  return key;
}

function getHeliusRpc(): string {
  const apiKey = getHeliusApiKey();
  const cluster = process.env.SOLANA_CLUSTER ?? "devnet";
  return cluster === "mainnet-beta"
    ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
    : `https://devnet.helius-rpc.com/?api-key=${apiKey}`;
}

/**
 * Fetch all ContentRecord program accounts for the amsets-registry program.
 * Uses a memcmp filter on the account discriminator to fetch ONLY ContentRecord
 * accounts, excluding ListingRecord, AccessReceipt, RegistryState, and FeeVault.
 *
 * ContentRecord discriminator = sha256("account:ContentRecord")[0..8]
 *   = [22, 30, 119, 161, 251, 124, 237, 60]
 */
async function fetchProgramAccounts(): Promise<Array<{ pubkey: string; account: { data: string[] } }>> {
  const rpc = getHeliusRpc();

  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      "amsets-marketplace",
      method:  "getProgramAccounts",
      params: [
        AMSETS_PROGRAM_ID,
        {
          encoding:   "base64",
          commitment: "confirmed",
          filters: [
            {
              // Filter by ContentRecord account discriminator (first 8 bytes)
              // sha256("account:ContentRecord")[0..8] = [22, 30, 119, 161, 251, 124, 237, 60]
              memcmp: {
                offset: 0,
                bytes:  Buffer.from(CONTENT_RECORD_DISCRIMINATOR).toString("base64"),
                encoding: "base64",
              },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Helius RPC error: ${res.status}`);
  const json = (await res.json()) as any;
  return json.result ?? [];
}

/**
 * Read the singleton RegistryState PDA from the blockchain.
 * PDA seeds: [b"registry"], program = AMSETS_PROGRAM_ID
 * Returns null if the PDA doesn't exist yet (before initialize_registry is called).
 */
export async function readRegistryState(): Promise<OnChainRegistryState | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  try {
    // Derive registry PDA off-chain: seeds = [b"registry"]
    // We fetch it by asking the RPC for the account at the known PDA address.
    const rpc = getHeliusRpc();

    // First get the registry PDA address by calling findProgramAddressSync equivalent
    // We'll use the Helius RPC to find it by getProgramAccounts with RegistryState discriminator
    const registryDisc = [29, 34, 224, 195, 175, 183, 99, 97]; // sha256("account:RegistryState")[0..8]

    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      "amsets-registry-state",
        method:  "getProgramAccounts",
        params: [
          AMSETS_PROGRAM_ID,
          {
            encoding:   "base64",
            commitment: "confirmed",
            filters: [
              {
                memcmp: {
                  offset: 0,
                  bytes:  Buffer.from(registryDisc).toString("base64"),
                  encoding: "base64",
                },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const accounts: Array<{ account: { data: string[] } }> = json.result ?? [];
    if (accounts.length === 0) return null;

    // Deserialize RegistryState
    // Layout after 8-byte discriminator:
    //   total_content[8 LE u64] | total_purchases[8 LE u64]
    //   | total_secondary_sales[8 LE u64] | total_sol_volume[8 LE u64] | bump[1]
    const [base64Data] = accounts[0].account.data;
    const buf = Buffer.from(base64Data, "base64");
    if (buf.length < 8 + 32) return null;

    let off = 8; // skip discriminator
    const totalContent         = buf.readBigUInt64LE(off); off += 8;
    const totalPurchases       = buf.readBigUInt64LE(off); off += 8;
    const totalSecondarySales  = buf.readBigUInt64LE(off); off += 8;
    const totalSolVolume       = buf.readBigUInt64LE(off);

    return { totalContent, totalPurchases, totalSecondarySales, totalSolVolume };
  } catch (err) {
    console.error("[helius] readRegistryState failed:", err);
    return null;
  }
}

/**
 * Fetch all ContentRecord accounts from Solana via Helius.
 * Returns parsed, structured content records for active content only.
 */
export async function fetchAllContentRecords(): Promise<OnChainContentRecord[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.warn("[helius] HELIUS_API_KEY not set — skipping on-chain fetch");
    return [];
  }

  try {
    const accounts = await fetchProgramAccounts();
    const records: OnChainContentRecord[] = [];

    for (const acc of accounts) {
      try {
        const [base64Data] = acc.account.data;
        const buffer       = Buffer.from(base64Data, "base64");
        const record = deserializeContentRecord(acc.pubkey, buffer);
        // Include both new-format (isActive=true) and old-format PDAs (basePrice=0
        // due to layout mismatch, but storage_uri is valid — they are active in DB).
        if (record && (record.isActive || record.storageUri.length > 0)) {
          records.push(record);
        }
      } catch {
        // Skip malformed accounts
      }
    }

    return records;
  } catch (err) {
    console.error("[helius] fetchAllContentRecords failed:", err);
    return [];
  }
}

/**
 * Fetch a single ContentRecord PDA by its address.
 * Returns null if not found or malformed.
 */
export async function fetchContentRecord(
  pdaAddress: string
): Promise<OnChainContentRecord | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  try {
    const rpc = getHeliusRpc();
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id:      "amsets-single",
        method:  "getAccountInfo",
        params:  [pdaAddress, { encoding: "base64", commitment: "confirmed" }],
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const data = json.result?.value?.data;
    if (!data) return null;

    const buffer = Buffer.from(data[0], "base64");
    return deserializeContentRecord(pdaAddress, buffer);
  } catch {
    return null;
  }
}

// ─── Base58 encoding ──────────────────────────────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(bytes: Buffer): string {
  let n = BigInt("0x" + bytes.toString("hex"));
  let result = "";
  while (n > 0n) {
    const rem = Number(n % 58n);
    result = BASE58_ALPHABET[rem] + result;
    n      = n / 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    result = "1" + result;
  }
  return result;
}
