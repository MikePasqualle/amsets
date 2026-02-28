import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema";
import { verifyWalletSignature } from "../services/solana.service";
import { signUserJwt } from "../services/jwt.service";

const authRouter = new Hono();

// ─── Verify wallet signature → issue JWT ─────────────────────────────────────

const verifySchema = z.object({
  wallet_address: z.string().min(32).max(44),
  signed_message: z.string().min(1),
  timestamp: z.number().int().positive(),
  auth_method: z
    .enum([
      "web3auth_email",
      "web3auth_phone",
      "web3auth_google",
      "web3auth_apple",
      "wallet_adapter",
    ])
    .optional()
    .default("wallet_adapter"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
});

authRouter.post(
  "/verify",
  zValidator("json", verifySchema),
  async (c) => {
    const { wallet_address, signed_message, timestamp, auth_method, email, phone } =
      c.req.valid("json");

    // Reject stale timestamps (older than 5 minutes)
    const nowMs = Date.now();
    if (Math.abs(nowMs - timestamp) > 5 * 60 * 1000) {
      return c.json({ error: "Signature timestamp expired" }, 401);
    }

    // The message must contain the wallet address and timestamp for replay protection
    const expectedMessage = `AMSETS auth: ${wallet_address} at ${timestamp}`;
    const isValid = verifyWalletSignature(
      wallet_address,
      expectedMessage,
      signed_message
    );

    if (!isValid) {
      return c.json({ error: "Invalid wallet signature" }, 401);
    }

    // Upsert user record
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.walletAddress, wallet_address))
      .limit(1);

    let user = existing[0];

    if (!user) {
      const [newUser] = await db
        .insert(users)
        .values({
          walletAddress: wallet_address,
          authMethod: auth_method as any,
          email: email ?? null,
          phone: phone ?? null,
        })
        .returning();
      user = newUser;
    }

    const token = signUserJwt({ sub: wallet_address, userId: user.id });

    return c.json({
      token,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        username: user.username,
        avatarUrl: user.avatarUrl,
        isOnChainAccountOpened: user.isOnChainAccountOpened,
      },
    });
  }
);

// ─── Verify content access → issue short-lived content JWT ───────────────────

const contentAccessSchema = z.object({
  content_id: z.string().min(1),
  access_mint: z.string().min(32).max(44),
});

authRouter.post(
  "/content-access",
  zValidator("json", contentAccessSchema),
  async (c) => {
    // Extract user JWT from Authorization header
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let walletAddress: string;
    try {
      const { verifyUserJwt } = await import("../services/jwt.service");
      const payload = verifyUserJwt(authHeader.replace("Bearer ", ""));
      walletAddress = payload.sub;
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const { content_id, access_mint } = c.req.valid("json");

    // Check NFT ownership via Helius DAS API
    const { checkNftOwnership } = await import("../services/solana.service");
    const hasAccess = await checkNftOwnership(walletAddress, access_mint);

    if (!hasAccess) {
      return c.json({ error: "Access NFT not found in wallet" }, 403);
    }

    const { signContentJwt } = await import("../services/jwt.service");
    const contentToken = signContentJwt({
      sub: walletAddress,
      contentId: content_id,
      allowedActions: ["view", "download_preview"],
    });

    return c.json({ content_token: contentToken });
  }
);

export { authRouter };
