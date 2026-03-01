/**
 * Admin Routes — platform settings, analytics, and fee management.
 *
 * All routes require the X-Admin-Secret header matching ADMIN_SECRET env variable.
 *
 * GET    /api/v1/admin/settings              — get current platform settings
 * PUT    /api/v1/admin/settings              — update platform settings
 * GET    /api/v1/admin/stats                 — revenue and usage statistics
 * GET    /api/v1/admin/wallets               — all wallet balances with descriptions
 * POST   /api/v1/admin/withdraw-fees         — withdraw FeeVault → platform_fee_wallet
 */

import { Hono } from "hono";
import {
  Connection, PublicKey, LAMPORTS_PER_SOL,
  Transaction, TransactionInstruction, SystemProgram, Keypair,
} from "@solana/web3.js";
import { db } from "../db/index";
import { purchases, content, users } from "../db/schema";
import { sum, count } from "drizzle-orm";
import { Pool } from "pg";
import bs58 from "bs58";

const adminRouter = new Hono();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const solanaConnection = new Connection(
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  "confirmed"
);

// ─── Auth middleware ───────────────────────────────────────────────────────────

function checkAdmin(c: any): boolean {
  const secret = c.req.header("X-Admin-Secret");
  return !!process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
}

// ─── GET /settings ────────────────────────────────────────────────────────────

adminRouter.get("/settings", async (c) => {
  if (!checkAdmin(c)) return c.json({ error: "Unauthorized" }, 401);

  const { rows } = await pool.query("SELECT key, value, updated_at FROM platform_settings");
  const settings: Record<string, string> = {};
  rows.forEach((r: any) => { settings[r.key] = r.value; });

  // Compute FeeVault balance live
  let feeVaultBalance = 0;
  try {
    const PROGRAM_ID = new PublicKey(
      process.env.NEXT_PUBLIC_PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG"
    );
    const [feeVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault")],
      PROGRAM_ID
    );
    const lamports = await solanaConnection.getBalance(feeVaultPda);
    feeVaultBalance = lamports / LAMPORTS_PER_SOL;
    settings["fee_vault_pda"]     = feeVaultPda.toBase58();
    settings["fee_vault_balance"] = feeVaultBalance.toFixed(6);
  } catch {
    settings["fee_vault_balance"] = "N/A";
  }

  return c.json({ settings });
});

// ─── PUT /settings ────────────────────────────────────────────────────────────

adminRouter.put("/settings", async (c) => {
  if (!checkAdmin(c)) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);

  const ALLOWED_KEYS = ["platform_fee_wallet", "platform_name", "platform_fee_bps"];

  const updates = Object.entries(body as Record<string, string>).filter(([k]) =>
    ALLOWED_KEYS.includes(k)
  );

  if (!updates.length) return c.json({ error: "No valid settings provided" }, 400);

  for (const [key, value] of updates) {
    await pool.query(
      "INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
      [key, String(value)]
    );
  }

  return c.json({ ok: true, updated: updates.map(([k]) => k) });
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

adminRouter.get("/stats", async (c) => {
  if (!checkAdmin(c)) return c.json({ error: "Unauthorized" }, 401);

  const [purchaseStats] = await db
    .select({
      totalPurchases: count(purchases.id),
      totalRevenue:   sum(purchases.amountPaid),
    })
    .from(purchases);

  const [contentStats] = await db
    .select({ totalContent: count(content.contentId) })
    .from(content);

  const [userStats] = await db
    .select({ totalUsers: count(users.walletAddress) })
    .from(users);

  // Platform fee = 2.5% of total revenue
  const totalRevenueSol = Number(purchaseStats?.totalRevenue ?? 0) / LAMPORTS_PER_SOL;
  const platformRevenueSol = totalRevenueSol * 0.025;

  // FeeVault live balance
  let feeVaultBalance = 0;
  let feeVaultPdaStr = "N/A";
  try {
    const PROGRAM_ID = new PublicKey(
      process.env.NEXT_PUBLIC_PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG"
    );
    const [feeVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fee_vault")],
      PROGRAM_ID
    );
    feeVaultPdaStr = feeVaultPda.toBase58();
    const lamports = await solanaConnection.getBalance(feeVaultPda);
    feeVaultBalance = lamports / LAMPORTS_PER_SOL;
  } catch { /* ignore */ }

  return c.json({
    purchases:       purchaseStats?.totalPurchases ?? 0,
    total_revenue_sol: totalRevenueSol.toFixed(6),
    platform_revenue_sol: platformRevenueSol.toFixed(6),
    fee_vault_balance_sol: feeVaultBalance.toFixed(6),
    fee_vault_pda:   feeVaultPdaStr,
    content:         contentStats?.totalContent ?? 0,
    users:           userStats?.totalUsers ?? 0,
  });
});

// ─── GET /wallets ─────────────────────────────────────────────────────────────

adminRouter.get("/wallets", async (c) => {
  if (!checkAdmin(c)) return c.json({ error: "Unauthorized" }, 401);

  const PROGRAM_ID = new PublicKey(
    process.env.PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG"
  );

  // Derive FeeVault PDA
  const [feeVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault")],
    PROGRAM_ID
  );

  // Derive MintAuthority public key from secret
  let mintAuthorityPubkey = "Not configured";
  try {
    const secret = process.env.MINT_AUTHORITY_SECRET;
    if (secret) {
      const kp = Keypair.fromSecretKey(bs58.decode(secret));
      mintAuthorityPubkey = kp.publicKey.toBase58();
    }
  } catch { /* ignore */ }

  // Get platform fee wallet from DB
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'platform_fee_wallet'"
  );
  const platformFeeWallet = rows[0]?.value ?? "Not configured";

  // Fetch all balances in parallel
  const [feeVaultBal, mintAuthorityBal, platformFeeBal] = await Promise.all([
    solanaConnection.getBalance(feeVaultPda).catch(() => 0),
    mintAuthorityPubkey !== "Not configured"
      ? solanaConnection.getBalance(new PublicKey(mintAuthorityPubkey)).catch(() => 0)
      : Promise.resolve(0),
    platformFeeWallet !== "Not configured"
      ? solanaConnection.getBalance(new PublicKey(platformFeeWallet)).catch(() => 0)
      : Promise.resolve(0),
  ]);

  // Rent-exempt minimum for zero-data account (~0.00089 SOL)
  const RENT_EXEMPT_MIN = 890_880;

  return c.json({
    wallets: [
      {
        name:        "FeeVault (Smart Contract)",
        address:     feeVaultPda.toBase58(),
        balanceSol:  (feeVaultBal / LAMPORTS_PER_SOL).toFixed(6),
        balanceLam:  feeVaultBal,
        withdrawable: Math.max(0, feeVaultBal - RENT_EXEMPT_MIN),
        purpose:     "Накопичує 2.5% комісії з кожного первинного продажу. Кошти знаходяться на смарт-контракті Solana. Для виводу натисніть «Вивести комісії».",
        needsTopUp:  false,
        minBalance:  0,
        status:      feeVaultBal > RENT_EXEMPT_MIN ? "ok" : "empty",
        canWithdraw: true,
      },
      {
        name:        "Mint Authority (Backend Server)",
        address:     mintAuthorityPubkey,
        balanceSol:  (mintAuthorityBal / LAMPORTS_PER_SOL).toFixed(6),
        balanceLam:  mintAuthorityBal,
        withdrawable: 0,
        purpose:     "Гаманець бекенд-сервера. Підписує транзакції мінтингу SPL-токенів доступу для покупців. Потребує SOL для оплати комісій транзакцій (~0.000005 SOL за мінт). Поповнюйте при балансі нижче 0.05 SOL.",
        needsTopUp:  mintAuthorityBal < 50_000_000, // < 0.05 SOL
        minBalance:  50_000_000,
        status:      mintAuthorityBal < 10_000_000 ? "critical" : mintAuthorityBal < 50_000_000 ? "low" : "ok",
        canWithdraw: false,
      },
      {
        name:        "Platform Fee Wallet (Власник)",
        address:     platformFeeWallet,
        balanceSol:  (platformFeeBal / LAMPORTS_PER_SOL).toFixed(6),
        balanceLam:  platformFeeBal,
        withdrawable: 0,
        purpose:     "Гаманець власника платформи. Отримує виведені комісії з FeeVault. Встановлюється в налаштуваннях адміна як «Platform Fee Wallet».",
        needsTopUp:  false,
        minBalance:  0,
        status:      "ok",
        canWithdraw: false,
      },
    ],
  });
});

// ─── POST /withdraw-fees ──────────────────────────────────────────────────────
// Withdraws all accumulated SOL from FeeVault PDA → platform_fee_wallet.
// Uses the upgrade authority keypair (solana CLI id.json) to sign the tx.

adminRouter.post("/withdraw-fees", async (c) => {
  if (!checkAdmin(c)) return c.json({ error: "Unauthorized" }, 401);

  // Load withdraw authority keypair from environment
  const authoritySecretPath = process.env.WITHDRAW_AUTHORITY_KEYPAIR;
  let authorityKeypair: Keypair;
  try {
    if (authoritySecretPath) {
      // JSON array format (solana CLI keypair file)
      const fs = await import("fs");
      const keyData = JSON.parse(fs.readFileSync(authoritySecretPath, "utf8")) as number[];
      authorityKeypair = Keypair.fromSecretKey(new Uint8Array(keyData));
    } else {
      // Fallback: try ~/.config/solana/id.json (upgrade authority)
      const fs = await import("fs");
      const os = await import("os");
      const defaultPath = `${os.homedir()}/.config/solana/id.json`;
      const keyData = JSON.parse(fs.readFileSync(defaultPath, "utf8")) as number[];
      authorityKeypair = Keypair.fromSecretKey(new Uint8Array(keyData));
    }
  } catch (err: any) {
    return c.json({ error: `Cannot load withdraw authority keypair: ${err?.message}` }, 500);
  }

  // Load recipient from DB
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'platform_fee_wallet'"
  );
  const recipientAddress = rows[0]?.value;
  if (!recipientAddress) {
    return c.json({ error: "platform_fee_wallet not configured in admin settings" }, 400);
  }

  const PROGRAM_ID = new PublicKey(
    process.env.PROGRAM_ID ?? "B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG"
  );

  const [feeVaultPda, feeVaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault")],
    PROGRAM_ID
  );

  const recipientPubkey = new PublicKey(recipientAddress);

  // Check available balance
  const vaultBalance = await solanaConnection.getBalance(feeVaultPda);
  const RENT_EXEMPT  = 890_880;
  const withdrawable = vaultBalance - RENT_EXEMPT;

  if (withdrawable <= 0) {
    return c.json({ error: "No withdrawable fees in FeeVault (balance at rent-exempt minimum)" }, 400);
  }

  // Build withdraw_fees instruction
  // Discriminator: sha256("global:withdraw_fees")[0..8]
  const discriminator = Buffer.from([198, 212, 171, 109, 144, 215, 174, 89]);
  // amount = 0 → withdraw all available
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(0));
  const ixData = Buffer.concat([discriminator, amountBuf]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authorityKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: feeVaultPda,                isSigner: false, isWritable: true  },
      { pubkey: recipientPubkey,            isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authorityKeypair.publicKey;

  try {
    const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(authorityKeypair);

    const signature = await solanaConnection.sendRawTransaction(tx.serialize());
    await solanaConnection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

    const withdrawnSol = (withdrawable / LAMPORTS_PER_SOL).toFixed(6);
    console.log(`[admin] Withdrew ${withdrawnSol} SOL from FeeVault → ${recipientAddress} | sig: ${signature.slice(0, 12)}…`);

    return c.json({
      ok:           true,
      signature,
      withdrawnLam: withdrawable,
      withdrawnSol,
      recipient:    recipientAddress,
      explorerUrl:  `https://solscan.io/tx/${signature}?cluster=devnet`,
    });
  } catch (err: any) {
    console.error("[admin] withdraw-fees error:", err?.message);
    return c.json({ error: `Withdrawal failed: ${err?.message?.slice(0, 200)}` }, 500);
  }
});

export { adminRouter };
