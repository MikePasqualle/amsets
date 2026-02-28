import nacl from "tweetnacl";
import bs58 from "bs58";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");

export const connection = new Connection(RPC_URL, "confirmed");

/**
 * Verify an Ed25519 wallet signature.
 * Used for both Web3Auth wallets and Phantom/Solflare wallets.
 *
 * @param walletAddress - Base58 public key
 * @param message       - The plaintext message that was signed
 * @param signature     - Base58-encoded signature
 */
export function verifyWalletSignature(
  walletAddress: string,
  message: string,
  signature: string
): boolean {
  try {
    const pubkeyBytes = bs58.decode(walletAddress);
    const sigBytes = bs58.decode(signature);
    const msgBytes = new TextEncoder().encode(message);

    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

/**
 * Check whether a wallet holds a specific SPL token (access NFT).
 * Uses Helius DAS API for efficient lookup.
 */
export async function checkNftOwnership(
  walletAddress: string,
  mintAddress: string
): Promise<boolean> {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) {
    // Fallback: direct RPC token account query
    return checkOwnershipFallback(walletAddress, mintAddress);
  }

  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: walletAddress,
          page: 1,
          limit: 1000,
        },
      }),
    });

    const data = (await response.json()) as {
      result: { items: Array<{ id: string }> };
    };
    return data.result.items.some((asset) => asset.id === mintAddress);
  } catch {
    return checkOwnershipFallback(walletAddress, mintAddress);
  }
}

async function checkOwnershipFallback(
  walletAddress: string,
  mintAddress: string
): Promise<boolean> {
  try {
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(mintAddress);
    const tokenAccounts = await connection.getTokenAccountsByOwner(wallet, {
      mint,
    });
    return tokenAccounts.value.length > 0;
  } catch {
    return false;
  }
}
