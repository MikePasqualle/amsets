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
 *   | primary_author[32] | access_mint[32]
 *   | base_price[8 LE u64] | payment_token[1] | license[1]
 *   | is_active[1] | bump[1]
 */

const AMSETS_PROGRAM_ID = process.env.PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG";

export interface OnChainContentRecord {
  pdaAddress: string;
  contentId: string;        // 32-byte hex
  contentHash: string;      // 32-byte hex
  storageUri: string;       // ar://{txId}
  previewUri: string;       // ipfs://{cid}
  primaryAuthor: string;    // base58 pubkey
  accessMint: string;       // base58 pubkey or "pending"
  basePrice: bigint;        // lamports
  paymentToken: "SOL" | "USDC";
  license: "personal" | "commercial" | "derivative" | "unlimited";
  isActive: boolean;
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

    // storage_uri
    let storageUri: string;
    [storageUri, offset] = readString(data, offset);

    // preview_uri
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

    return {
      pdaAddress,
      contentId,
      contentHash,
      storageUri,
      previewUri,
      primaryAuthor,
      accessMint,
      basePrice,
      paymentToken: TOKEN_MAP[paymentTokenIdx] ?? "SOL",
      license:      LICENSE_MAP[licenseIdx]    ?? "personal",
      isActive,
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
 * Fetch all program accounts for the amsets-registry program.
 * Returns raw account data that can be deserialized with deserializeContentRecord.
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
            // ContentRecord accounts: discriminator = [170, 55, 41, 115, 252, 248, 38, 144]
            // Filter by the register_content discriminator (first 8 bytes match)
            // Note: Anchor uses sha256("account:ContentRecord")[0..8] for account discriminator
            // which differs from the instruction discriminator
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
        const record       = deserializeContentRecord(acc.pubkey, buffer);
        if (record && record.isActive) {
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
