/**
 * Admin Routes — platform settings and analytics.
 *
 * All routes require the X-Admin-Secret header matching ADMIN_SECRET env variable.
 *
 * GET    /api/v1/admin/settings              — get current platform settings
 * PUT    /api/v1/admin/settings              — update platform settings
 * GET    /api/v1/admin/stats                 — revenue and usage statistics
 */

import { Hono } from "hono";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { db } from "../db/index";
import { purchases, content, users } from "../db/schema";
import { sum, count } from "drizzle-orm";
import { Pool } from "pg";

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

export { adminRouter };
