/**
 * Client-side cryptography utilities.
 * All operations run in the browser via the Web Crypto API (no server involvement).
 *
 * Flow:
 *   1. generateSymmetricKey() → AES-256-GCM key
 *   2. encryptFile(key, buffer) → { ciphertext, iv }
 *   3. Upload ciphertext to Arweave
 *   4. encryptKeyForContent(key) via lit.ts → encrypted key bundle
 *   5. Store encrypted bundle in backend DB
 *
 * Decryption flow (purchase):
 *   1. decryptKeyForContent() via lit.ts → raw key bytes
 *   2. importSymmetricKey(bytes) → CryptoKey
 *   3. decryptFile(key, iv, ciphertext) → original buffer
 */

// ─── SHA-256 ──────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file buffer.
 * Returns the hex string (64 chars) used as content_hash on-chain.
 */
export async function computeSHA256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── AES-256-GCM key generation ───────────────────────────────────────────────

/**
 * Generate a fresh AES-256-GCM symmetric key.
 * This key is used to encrypt the content file before uploading to Arweave.
 */
export async function generateSymmetricKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable — needed to pass to Lit Protocol
    ["encrypt", "decrypt"]
  );
}

/**
 * Export a CryptoKey to raw bytes (Uint8Array).
 * Used before passing the key to Lit Protocol for encryption.
 */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

/**
 * Import raw key bytes back into a CryptoKey.
 * Used after Lit Protocol decryption to reconstruct the AES key.
 */
export async function importSymmetricKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable after import — security measure
    ["decrypt"]
  );
}

// ─── AES-256-GCM encrypt / decrypt ───────────────────────────────────────────

export interface EncryptedResult {
  /** AES-GCM encrypted file bytes */
  ciphertext: ArrayBuffer;
  /** 12-byte random IV — must be stored alongside ciphertext */
  iv: Uint8Array;
}

/**
 * Encrypt a file buffer with AES-256-GCM.
 * The resulting ciphertext + iv are uploaded to Arweave together.
 */
export async function encryptFile(
  key: CryptoKey,
  buffer: ArrayBuffer
): Promise<EncryptedResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: "AES-GCM", iv: iv as any },
    key,
    buffer
  );

  return { ciphertext, iv };
}

/**
 * Decrypt AES-256-GCM ciphertext back to original file bytes.
 * Called after Lit Protocol provides the decrypted symmetric key.
 */
export async function decryptFile(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: ArrayBuffer
): Promise<ArrayBuffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as any }, key, ciphertext);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pack iv + ciphertext into a single ArrayBuffer for Arweave upload.
 * Format: [12 bytes IV][ciphertext...]
 */
export function packEncrypted(iv: Uint8Array, ciphertext: ArrayBuffer): ArrayBuffer {
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return result.buffer;
}

/**
 * Unpack a combined IV+ciphertext buffer (from Arweave).
 */
export function unpackEncrypted(packed: ArrayBuffer): { iv: Uint8Array; ciphertext: ArrayBuffer } {
  const view = new Uint8Array(packed);
  const iv = view.slice(0, 12);
  const ciphertext = view.slice(12).buffer;
  return { iv, ciphertext };
}
