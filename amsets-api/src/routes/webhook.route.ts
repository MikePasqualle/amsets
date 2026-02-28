/**
 * Helius Webhook Handler for AMSETS.
 *
 * Helius sends a POST request to this endpoint whenever a new transaction
 * is confirmed for the amsets-registry program.
 *
 * Handler logic:
 *   1. Verify the request is from Helius (Authorization header check)
 *   2. Parse the transaction to identify register_content / purchase events
 *   3. Invalidate the relevant Redis cache keys
 *   4. Optionally update the PostgreSQL record
 *
 * To register this webhook in Helius dashboard:
 *   - URL: https://your-api.com/api/v1/webhook/helius
 *   - Event type: TRANSACTION
 *   - Account: 9KZywKubm7SfwBm8Zs3ZMgLD6tjxWDzmMK6yugz58Vst
 */

import { Hono } from "hono";
import { cacheDel, cacheSet } from "../db/redis";
import { fetchContentRecord } from "../services/helius.service";
import { db } from "../db/index";
import { content as contentTable } from "../db/schema";
import { eq } from "drizzle-orm";

const webhookRouter = new Hono();

// ─── Helius Webhook POST /api/v1/webhook/helius ───────────────────────────────

webhookRouter.post("/helius", async (c) => {
  // Optional webhook secret verification
  const secret         = process.env.HELIUS_WEBHOOK_SECRET;
  const authHeader     = c.req.header("Authorization");

  if (secret && authHeader !== `Bearer ${secret}`) {
    console.warn("[webhook] Unauthorized Helius webhook attempt");
    return c.json({ error: "Unauthorized" }, 401);
  }

  let events: any[];
  try {
    events = await c.req.json();
    if (!Array.isArray(events)) events = [events];
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  console.log(`[webhook/helius] Received ${events.length} event(s)`);

  for (const event of events) {
    try {
      await processHeliusEvent(event);
    } catch (err) {
      console.error("[webhook/helius] Event processing failed:", err);
    }
  }

  return c.json({ received: true, count: events.length });
});

// ─── Event processor ──────────────────────────────────────────────────────────

async function processHeliusEvent(event: any): Promise<void> {
  const { type, accountData, description } = event;

  // Invalidate marketplace cache on any program transaction
  await cacheDel("marketplace:all::1:20");
  await cacheDel("marketplace:all::1:50");

  // Try to extract PDA addresses from the event's account data
  if (Array.isArray(accountData)) {
    for (const acc of accountData) {
      const pdaAddress: string | undefined = acc?.account;
      if (!pdaAddress) continue;

      // Fetch the updated ContentRecord from Helius and cache it
      const record = await fetchContentRecord(pdaAddress);
      if (!record) continue;

      // Convert content_id hex to UUID-like format used in PostgreSQL
      const contentIdHex = record.contentId;

      // Update PostgreSQL cache if record exists
      const [existing] = await db
        .select({ id: contentTable.id })
        .from(contentTable)
        .where(eq(contentTable.contentId, contentIdHex))
        .limit(1);

      if (existing) {
        // Sync on-chain data to PostgreSQL cache
        await db
          .update(contentTable)
          .set({
            storageUri:  record.storageUri,
            accessMint:  record.accessMint !== "pending" ? record.accessMint : undefined,
            onChainPda:  pdaAddress,
            status:      record.isActive ? "active" : "inactive",
            updatedAt:   new Date(),
          })
          .where(eq(contentTable.contentId, contentIdHex));

        // Invalidate the individual content cache
        await cacheDel(`content:${contentIdHex}`);

        console.log(`[webhook/helius] Updated cache for content ${contentIdHex.slice(0, 8)}…`);
      }
    }
  }

  console.log(`[webhook/helius] Processed event type: ${type ?? "unknown"}`);
}

/**
 * GET /api/v1/webhook/helius — health check endpoint for Helius to verify the URL.
 */
webhookRouter.get("/helius", (c) =>
  c.json({ status: "ok", handler: "AMSETS Helius Webhook" })
);

export { webhookRouter };
