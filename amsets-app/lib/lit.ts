/**
 * Lit Protocol wrapper for AMSETS (Lit Protocol v7+).
 *
 * Lit Protocol is a decentralized KMS (Key Management Service).
 * It encrypts the AES-256 symmetric key using threshold cryptography,
 * and decrypts it only when the requester's wallet satisfies the
 * Solana Access Control Conditions (ACCs).
 *
 * For AMSETS, the ACC checks: "does this wallet hold ≥1 of the access SPL token?"
 *
 * Lit Protocol v7 API:
 *   Encrypt: encryptString() → { ciphertext, dataToEncryptHash }
 *   Decrypt: decryptToString() with sessionSigs
 *
 * Usage:
 *   Upload flow:  encryptKeyForContent(key, accessMint) → AmsetsLitBundle
 *   View flow:    decryptKeyFromBundle(bundle, authParams) → CryptoKey
 *
 * Network: "datil-dev" (testnet) | "datil" (mainnet)
 */

import { exportKey, importSymmetricKey } from "./crypto";
import type { AmsetsLitBundle } from "./arweave-bundle";

type LitNodeClient = any;

// ─── Access Control Conditions ────────────────────────────────────────────────

/**
 * Build Solana Access Control Conditions for an AMSETS access token.
 * Condition: wallet must hold at least 1 token of the given SPL mint.
 *
 * Uses the "solana" chain RPC condition format compatible with Lit Protocol v7.
 */
export function buildSolanaACCs(accessMint: string) {
  return [
    {
      method: "balanceOfToken",
      params: [accessMint],
      pdaParams: [],
      pdaInterface: { offset: 0, fields: {} },
      pdaKey: "",
      chain: "solana",
      returnValueTest: {
        key: "$.amount",
        comparator: ">=",
        value: "1",
      },
    },
  ];
}

/**
 * Build Solana ACCs that check for an AccessReceipt PDA.
 * Used as fallback when SPL mint is not yet created.
 * The condition checks if the AccessReceipt account exists (non-zero lamports).
 */
export function buildReceiptACCs(accessReceiptPda: string) {
  return [
    {
      method: "getBalance",
      params: [accessReceiptPda],
      chain: "solana",
      returnValueTest: {
        key: "",
        comparator: ">",
        value: "0",
      },
    },
  ];
}

// ─── Lit client singleton ─────────────────────────────────────────────────────

let litClient: LitNodeClient | null = null;

async function getLitClient(): Promise<LitNodeClient> {
  if (litClient?.ready) return litClient;

  const { LitNodeClient } = await import("@lit-protocol/lit-node-client");
  const network = (process.env.NEXT_PUBLIC_LIT_NETWORK ?? "datil-dev") as any;

  litClient = new LitNodeClient({ litNetwork: network, debug: false });
  await litClient.connect();
  return litClient;
}

// ─── Session signatures ───────────────────────────────────────────────────────

export interface SolanaSignParams {
  walletAddress: string;
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Build a Lit AuthSig (legacy format, still accepted by datil-dev).
 * For Solana wallets — signs a message string and returns the AuthSig.
 */
export async function buildSolanaAuthSig(
  params: SolanaSignParams
): Promise<{ sig: string; derivedVia: string; signedMessage: string; address: string }> {
  const { walletAddress, signMessage } = params;

  // Standard Lit message format
  const expiry = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
  const message =
    `I am signing this message to authenticate with Lit Protocol.\n` +
    `Wallet: ${walletAddress}\n` +
    `Expires: ${expiry}`;

  const msgBytes  = new TextEncoder().encode(message);
  const sigBytes  = await signMessage(msgBytes);
  const sigBase58 = uint8ArrayToBase58(sigBytes);

  return {
    sig:           sigBase58,
    derivedVia:    "solana:signMessage",
    signedMessage: message,
    address:       walletAddress,
  };
}

// ─── Encryption ───────────────────────────────────────────────────────────────

/**
 * Encrypt the AES-256-GCM symmetric key via Lit Protocol.
 * Called during content upload, BEFORE registering on-chain.
 *
 * @param symmetricKey  - The raw CryptoKey used to encrypt the content
 * @param accessMint    - SPL token mint buyers will receive (can be "pending")
 * @returns AmsetsLitBundle to embed in the Arweave bundle
 */
export async function encryptKeyForContent(
  symmetricKey: CryptoKey,
  accessMint: string
): Promise<AmsetsLitBundle> {
  const client = await getLitClient();
  const accs   = buildSolanaACCs(accessMint);
  const keyBytes   = await exportKey(symmetricKey);
  const keyBase64  = uint8ArrayToBase64(keyBytes);

  // Lit Protocol v7: encryption is a method on the client instance
  const { ciphertext, dataToEncryptHash } = await client.encrypt({
    dataToEncrypt:    new TextEncoder().encode(keyBase64),
    solRpcConditions: accs,
  });

  return { ciphertext, data_to_encrypt_hash: dataToEncryptHash };
}

// ─── Decryption ───────────────────────────────────────────────────────────────

export interface DecryptParams {
  litBundle: AmsetsLitBundle;
  accessMint: string;
  walletAddress: string;
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Decrypt the symmetric key via Lit Protocol.
 * The wallet must hold ≥1 access token or an AccessReceipt PDA.
 *
 * @returns Reconstructed AES-256-GCM CryptoKey ready for decryption
 */
export async function decryptKeyFromBundle(
  params: DecryptParams
): Promise<CryptoKey> {
  const { litBundle, accessMint, walletAddress, signMessage } = params;

  const client  = await getLitClient();
  const accs    = buildSolanaACCs(accessMint);
  const authSig = await buildSolanaAuthSig({ walletAddress, signMessage });

  // Lit Protocol v7: decryption is a method on the client instance
  const { decryptedData } = await client.decrypt({
    solRpcConditions:  accs,
    ciphertext:        litBundle.ciphertext,
    dataToEncryptHash: litBundle.data_to_encrypt_hash,
    chain:             "solana",
    authSig,
  });

  const decryptedKeyBase64: string = new TextDecoder().decode(decryptedData);

  const keyBytes = base64ToUint8Array(decryptedKeyBase64);
  return importSymmetricKey(keyBytes);
}

/**
 * Legacy decrypt API (used by ContentViewer with encryptedKey + hash from DB).
 * Kept for backward compatibility with content registered before Phase 1.
 */
export async function decryptKeyForContent(
  encryptedKey: string,
  hash: string,
  authSig: { sig: string; derivedVia: string; signedMessage: string; address: string },
  accessMint: string
): Promise<CryptoKey> {
  const client = await getLitClient();
  const accs   = buildSolanaACCs(accessMint);

  // Lit Protocol v7: decryption via client.decrypt()
  const { decryptedData } = await client.decrypt({
    solRpcConditions:  accs,
    ciphertext:        encryptedKey,
    dataToEncryptHash: hash,
    chain:             "solana",
    authSig,
  });

  const decryptedKeyBase64: string = new TextDecoder().decode(decryptedData);

  const keyBytes = base64ToUint8Array(decryptedKeyBase64);
  return importSymmetricKey(keyBytes);
}

/**
 * Build an AuthSig from pre-computed signature components.
 */
export function buildAuthSig(
  walletAddress: string,
  signature: string,
  message: string
): { sig: string; derivedVia: string; signedMessage: string; address: string } {
  return {
    sig:           signature,
    derivedVia:    "solana:signMessage",
    signedMessage: message,
    address:       walletAddress,
  };
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Chunk-safe: avoids "Maximum call stack size exceeded" for large arrays.
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode Uint8Array to base58 string.
 * Uses a simple digit-by-digit algorithm (no BigInt) for ES2019 compatibility.
 */
function uint8ArrayToBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits   = [0];

  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry    += digits[j] << 8;
      digits[j] = carry % 58;
      carry     = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let result = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += "1";
  for (let i = digits.length - 1; i >= 0; i--) result += ALPHABET[digits[i]];
  return result;
}
