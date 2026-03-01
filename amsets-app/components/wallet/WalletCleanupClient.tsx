"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { GlowButton } from "@/components/ui/GlowButton";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface TokenInfo {
  mint: string;
  account: string;
  amount: bigint;
  decimals: number;
  uiAmount: string;
  inDatabase: boolean;
  status: "idle" | "burning" | "closing" | "done" | "error";
  error?: string;
}

async function sendAndConfirm(
  sendTransaction: any,
  connection: any,
  tx: Transaction,
  publicKey: PublicKey
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash      = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer             = publicKey;
  const sig = await sendTransaction(tx, connection, { skipPreflight: true });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

export default function WalletCleanupClient() {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const [tokens, setTokens]   = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);

  const scanWallet = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setScanned(false);
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      });

      const dbRes   = await fetch(`${API_URL}/api/v1/marketplace?limit=200`).catch(() => null);
      const dbData  = dbRes?.ok ? await dbRes.json() : {};
      const dbMints = new Set<string>(
        (dbData.items ?? []).map((item: any) => item.mintAddress).filter(Boolean)
      );

      const result: TokenInfo[] = accounts.value.map(({ pubkey, account }) => {
        const parsed   = account.data.parsed.info;
        const mint     = parsed.mint as string;
        const amount   = BigInt(parsed.tokenAmount.amount as string);
        const decimals = parsed.tokenAmount.decimals as number;
        const uiAmount = parsed.tokenAmount.uiAmountString as string;
        return {
          mint,
          account: pubkey.toBase58(),
          amount,
          decimals,
          uiAmount,
          inDatabase: dbMints.has(mint),
          status: "idle",
        };
      });

      setTokens(result);
      setScanned(true);
    } catch (err: any) {
      console.error("Scan failed:", err);
    } finally {
      setLoading(false);
    }
  }, [publicKey, connection]);

  useEffect(() => {
    if (connected && publicKey) scanWallet();
  }, [connected, publicKey, scanWallet]);

  // Burn tokens (if balance > 0), then close the empty account
  const burnAndClose = useCallback(async (token: TokenInfo) => {
    if (!publicKey || !sendTransaction) {
      alert("Connect Phantom wallet first.");
      return;
    }

    setTokens(prev => prev.map(t =>
      t.mint === token.mint ? { ...t, status: "burning", error: undefined } : t
    ));

    try {
      const mint = new PublicKey(token.mint);
      const ata  = new PublicKey(token.account);

      // Step 1: Burn if balance > 0
      if (token.amount > BigInt(0)) {
        console.log("[burn] Burning", token.amount.toString(), "tokens…");
        const burnTx = new Transaction();
        burnTx.add(
          createBurnCheckedInstruction(
            ata, mint, publicKey,
            token.amount, token.decimals,
            [], TOKEN_2022_PROGRAM_ID
          )
        );
        const burnSig = await sendAndConfirm(sendTransaction, connection, burnTx, publicKey);
        console.log("[burn] Burned! sig:", burnSig.slice(0, 12));
      }

      // Step 2: Close the empty account to reclaim rent SOL
      setTokens(prev => prev.map(t =>
        t.mint === token.mint ? { ...t, status: "closing" } : t
      ));
      console.log("[burn] Closing account…");
      const closeTx = new Transaction();
      closeTx.add(
        createCloseAccountInstruction(
          ata,
          publicKey, // rent destination
          publicKey, // authority
          [],
          TOKEN_2022_PROGRAM_ID
        )
      );
      const closeSig = await sendAndConfirm(sendTransaction, connection, closeTx, publicKey);
      console.log("[burn] Account closed! sig:", closeSig.slice(0, 12));

      setTokens(prev => prev.map(t =>
          t.mint === token.mint ? { ...t, status: "done", amount: BigInt(0) } : t
      ));
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error("[burn] Failed:", msg);
      setTokens(prev => prev.map(t =>
        t.mint === token.mint ? { ...t, status: "error", error: msg } : t
      ));
    }
  }, [publicKey, sendTransaction, connection]);

  // Close an already-empty account (balance was already burned)
  const closeEmpty = useCallback(async (token: TokenInfo) => {
    if (!publicKey || !sendTransaction) {
      alert("Connect Phantom wallet first.");
      return;
    }

    setTokens(prev => prev.map(t =>
      t.mint === token.mint ? { ...t, status: "closing", error: undefined } : t
    ));

    try {
      const ata = new PublicKey(token.account);
      const closeTx = new Transaction();
      closeTx.add(
        createCloseAccountInstruction(
          ata, publicKey, publicKey, [], TOKEN_2022_PROGRAM_ID
        )
      );
      const sig = await sendAndConfirm(sendTransaction, connection, closeTx, publicKey);
      console.log("[close] Done! sig:", sig.slice(0, 12));
      setTokens(prev => prev.map(t =>
        t.mint === token.mint ? { ...t, status: "done" } : t
      ));
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error("[close] Failed:", msg);
      setTokens(prev => prev.map(t =>
        t.mint === token.mint ? { ...t, status: "error", error: msg } : t
      ));
    }
  }, [publicKey, sendTransaction, connection]);

  const unknownTokens  = tokens.filter(t => !t.inDatabase && t.status !== "done");
  const emptyOrphans    = unknownTokens.filter(t => t.amount === BigInt(0));
  const nonEmptyOrphans = unknownTokens.filter(t => t.amount > BigInt(0));

  return (
    <div className="min-h-screen bg-[#0D0A14] pt-24 pb-16 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold text-[#EDE8F5] mb-2">My Wallet</h1>
        <p className="text-[#7A6E8E] mb-8 text-sm">
          Scan your wallet for unknown or orphaned SPL Token-2022 tokens.
          Removing a token returns the rent SOL back to your wallet.
        </p>

        {!connected ? (
          <div className="rounded-2xl border border-[#3D2F5A] bg-[#130D20] p-8 text-center">
            <p className="text-[#7A6E8E]">Connect your Phantom or Solflare wallet to scan for tokens.</p>
          </div>
        ) : (
          <>
            <GlowButton variant="primary" size="md" isLoading={loading} onClick={scanWallet} className="mb-8">
              {loading ? "Scanning…" : scanned ? "Rescan Wallet" : "Scan Wallet"}
            </GlowButton>

            {scanned && (
              <>
                <div className="grid grid-cols-2 gap-4 mb-8">
                  <div className="rounded-xl border border-[#3D2F5A] bg-[#130D20] p-4">
                    <p className="text-[#7A6E8E] text-xs uppercase tracking-wider mb-1">Total token accounts</p>
                    <p className="text-[#EDE8F5] text-2xl font-bold">{tokens.length}</p>
                  </div>
                  <div className="rounded-xl border border-[#3D2F5A] bg-[#130D20] p-4">
                    <p className="text-[#7A6E8E] text-xs uppercase tracking-wider mb-1">Unknown / orphaned</p>
                    <p className="text-2xl font-bold" style={{ color: unknownTokens.length > 0 ? "#FF6B6B" : "#81D0B5" }}>
                      {unknownTokens.length}
                    </p>
                  </div>
                </div>

                {unknownTokens.length === 0 ? (
                  <div className="rounded-2xl border border-[#81D0B5]/30 bg-[#081A15] p-6 text-center">
                    <p className="text-[#81D0B5] font-medium">Your wallet is clean — no unknown tokens found.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    {/* Tokens with balance — need burn + close */}
                    {nonEmptyOrphans.map(token => (
                      <div key={token.mint} className="rounded-xl border border-[#FF6B6B]/30 bg-[#1A0D0D] p-4 flex flex-col gap-3">
                        <div>
                          <p className="text-[#FF6B6B] text-xs font-semibold uppercase tracking-wider">Unknown Token</p>
                          <p className="text-[#EDE8F5] font-mono text-xs break-all mt-1">{token.mint}</p>
                          <p className="text-[#7A6E8E] text-xs mt-1">Balance: {token.uiAmount}</p>
                        </div>
                        {token.status === "error" && (
                          <div className="bg-[#FF6B6B]/10 rounded-lg p-3">
                            <p className="text-[#FF6B6B] text-xs font-semibold mb-1">Error:</p>
                            <p className="text-[#FF6B6B] text-xs font-mono break-all">{token.error}</p>
                          </div>
                        )}
                        <GlowButton
                          variant="ghost" size="sm"
                          isLoading={token.status === "burning" || token.status === "closing"}
                          onClick={() => burnAndClose(token)}
                          disabled={token.status === "burning" || token.status === "closing"}
                        >
                          {token.status === "burning" ? "Burning tokens… (1/2)"
                            : token.status === "closing" ? "Closing account… (2/2)"
                            : "Burn & Remove (reclaim rent SOL)"}
                        </GlowButton>
                      </div>
                    ))}

                    {/* Empty accounts — already burned, just need close */}
                    {emptyOrphans.map(token => (
                      <div key={token.mint} className="rounded-xl border border-[#F7FF88]/20 bg-[#131300] p-4 flex flex-col gap-3">
                        <div>
                          <p className="text-[#F7FF88] text-xs font-semibold uppercase tracking-wider">Empty Token Account (burnt, not closed)</p>
                          <p className="text-[#EDE8F5] font-mono text-xs break-all mt-1">{token.mint}</p>
                          <p className="text-[#7A6E8E] text-xs mt-1">Balance: 0 — token was burned but account still exists in Phantom</p>
                        </div>
                        {token.status === "error" && (
                          <div className="bg-[#FF6B6B]/10 rounded-lg p-3">
                            <p className="text-[#FF6B6B] text-xs font-semibold mb-1">Error:</p>
                            <p className="text-[#FF6B6B] text-xs font-mono break-all">{token.error}</p>
                          </div>
                        )}
                        <GlowButton
                          variant="ghost" size="sm"
                          isLoading={token.status === "closing"}
                          onClick={() => closeEmpty(token)}
                          disabled={token.status === "closing"}
                        >
                          {token.status === "closing" ? "Closing account…" : "Close account & reclaim rent SOL"}
                        </GlowButton>
                      </div>
                    ))}
                  </div>
                )}

                {tokens.filter(t => t.inDatabase && t.status !== "done").length > 0 && (
                  <div className="mt-8">
                    <h2 className="text-[#EDE8F5] font-semibold text-lg mb-4">AMSETS Access Tokens</h2>
                    <div className="flex flex-col gap-3">
                      {tokens.filter(t => t.inDatabase && t.status !== "done").map(token => (
                        <div key={token.mint} className="rounded-xl border border-[#3D2F5A] bg-[#130D20] p-4">
                          <p className="text-[#81D0B5] text-xs font-semibold uppercase tracking-wider mb-1">AMSETS Token</p>
                          <p className="text-[#EDE8F5] font-mono text-xs break-all">{token.mint}</p>
                          <p className="text-[#7A6E8E] text-xs mt-1">Balance: {token.uiAmount}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
