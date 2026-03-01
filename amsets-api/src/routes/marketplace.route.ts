/**
 * Marketplace API route.
 *
 * Data flow (decentralized — Phase 3):
 *   Request → Redis (5 min TTL) → return cached
 *          ↓ (cache miss)
 *   Helius DAS API → fetch all ContentRecord PDAs → parse → enrich from Arweave bundles → cache
 *          ↓ (Helius unavailable)
 *   PostgreSQL fallback → cache
 *
 * PostgreSQL is the primary source for: title, description, category (cached from Arweave bundles).
 * Solana is the primary source for: price, status, access_mint, storage_uri.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, ilike, and, desc, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { content } from "../db/schema";
import { cacheGet, cacheSet } from "../db/redis";
import { fetchAllContentRecords, readRegistryState } from "../services/helius.service";

const marketplaceRouter = new Hono();

const listQuerySchema = z.object({
  category: z.string().optional(),
  search:   z.string().optional(),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(50).default(20),
  source:   z.enum(["auto", "chain", "db"]).default("auto"),
});

/**
 * GET /api/v1/marketplace
 *
 * Returns paginated content visible to everyone.
 * Data source priority: Helius (on-chain) → PostgreSQL fallback.
 * Results are Redis-cached for 5 minutes.
 */
marketplaceRouter.get(
  "/",
  zValidator("query", listQuerySchema),
  async (c) => {
    const { category, search, page, limit, source } = c.req.valid("query");
    const offset    = (page - 1) * limit;
    const cacheKey  = `marketplace:${category ?? "all"}:${search ?? ""}:${page}:${limit}`;

    // ── Cache check ──────────────────────────────────────────────────────────
    if (source !== "chain") {
      const cached = await cacheGet<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    // ── Try Helius (on-chain source) ─────────────────────────────────────────
    if (source !== "db" && process.env.HELIUS_API_KEY) {
      try {
        const chainRecords = await fetchAllContentRecords();

        if (chainRecords.length > 0) {
          // Enrich on-chain data with metadata from PostgreSQL cache
          const enriched = await enrichWithDbMetadata(chainRecords);

          // Apply filters
          let filtered = enriched;
          if (category) {
            filtered = filtered.filter((r) =>
              r.category?.toLowerCase() === category.toLowerCase()
            );
          }
          if (search) {
            const q = search.toLowerCase();
            filtered = filtered.filter(
              (r) => r.title?.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)
            );
          }

          // Sort: active first, then by newest
          filtered.sort((a, b) => {
            if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
            return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
          });

          // Paginate
          const paginated = filtered.slice(offset, offset + limit);

          const response = {
            items:  paginated,
            page,
            limit,
            total:  filtered.length,
            source: "chain",
          };

          await cacheSet(cacheKey, response, 300);
          return c.json(response);
        }
      } catch (err) {
        console.warn("[marketplace] Helius fetch failed, falling back to PostgreSQL:", err);
      }
    }

    // ── PostgreSQL fallback ───────────────────────────────────────────────────
    // Only show published (active), non-private content on the public marketplace.
    // Drafts and private content are only visible to the author.
    const conditions = [eq(content.status, "active"), eq(content.isPrivate, false)];
    if (category) conditions.push(eq(content.category, category));
    if (search)   conditions.push(ilike(content.title, `%${search}%`));

    const items = await db
      .select({
        id:           content.id,
        contentId:    content.contentId,
        title:        content.title,
        description:  content.description,
        category:     content.category,
        tags:         content.tags,
        previewUri:   content.previewUri,
        authorWallet: content.authorWallet,
        basePrice:    content.basePrice,
        paymentToken: content.paymentToken,
        license:      content.license,
        accessMint:   content.accessMint,
        onChainPda:   content.onChainPda,
        status:       content.status,
        storageUri:   content.storageUri,
        createdAt:    content.createdAt,
      })
      .from(content)
      .where(and(...conditions))
      .orderBy(desc(content.createdAt))
      .limit(limit)
      .offset(offset);

    const serialized = items.map((item) => ({
      ...item,
      basePrice: item.basePrice?.toString() ?? "0",
      isActive:  item.status === "active",
    }));

    const response = { items: serialized, page, limit, source: "db" };
    await cacheSet(cacheKey, response, 300);
    return c.json(response);
  }
);

// ─── Enrich on-chain records with PostgreSQL metadata ────────────────────────

interface EnrichedRecord {
  contentId: string;
  pdaAddress: string;
  title: string;
  description?: string;
  category?: string;
  tags?: string[];
  previewUri: string;
  authorWallet: string;
  basePrice: string;
  paymentToken: "SOL" | "USDC";
  license: string;
  accessMint: string;
  mintAddress?: string | null;
  onChainPda: string;
  storageUri: string;
  status: string;
  isActive: boolean;
  totalSupply?: number;
  availableSupply?: number;
  royaltyBps?: number;
  minRoyaltyLamports?: number;
  authorNftMint?: string;
  soldCount?: number;
  mimeType?: string | null;
  createdAt?: Date;
}

async function enrichWithDbMetadata(
  records: Awaited<ReturnType<typeof fetchAllContentRecords>>
): Promise<EnrichedRecord[]> {
  if (records.length === 0) return [];

  const onChainIds = records.map((r) => r.contentId.slice(0, 32));

  // Fetch ALL DB rows for the on-chain IDs (both active and draft) so we can
  // check the DB status for each record and auto-sync stale drafts.
  const dbRows = await db
    .select({
      contentId:   content.contentId,
      title:       content.title,
      description: content.description,
      category:    content.category,
      tags:        content.tags,
      previewUri:  content.previewUri,
      mintAddress: content.mintAddress,
      basePrice:     content.basePrice,
      totalSupply:   content.totalSupply,
      royaltyBps:    content.royaltyBps,
      soldCount:     content.soldCount,
      mimeType:      content.mimeType,
      createdAt:     content.createdAt,
      status:        content.status,
      onChainPda:    content.onChainPda,
      authorNftMint: content.authorNftMint,
    })
    .from(content)
    .where(inArray(content.contentId, onChainIds));

  const dbMap = new Map(dbRows.map((r) => [r.contentId.slice(0, 32), r]));

  // Auto-sync: content that is confirmed on-chain but still shows "draft" in DB
  // means the PATCH /publish call failed after the Solana tx. Fix it now.
  const draftIds = dbRows
    .filter((r) => r.status === "draft" && onChainIds.includes(r.contentId.slice(0, 32)))
    .map((r) => r.contentId);

  if (draftIds.length > 0) {
    console.log(`[marketplace] Auto-syncing ${draftIds.length} on-chain records stuck in draft:`, draftIds);
    // Build a map of onChainPda per contentId for the sync
    const pdaMap = new Map(records.map((r) => [r.contentId.slice(0, 32), r.pdaAddress]));
    // Update each in background with its actual PDA address
    Promise.all(
      draftIds.map((id) => {
        const pda = pdaMap.get(id.slice(0, 32));
        return db.update(content)
          .set({ status: "active", ...(pda ? { onChainPda: pda } : {}) })
          .where(eq(content.contentId, id))
          .execute();
      })
    ).catch((err) => console.error("[marketplace] Auto-sync failed:", err));
    // Reflect immediately in our in-memory map so this response is correct
    draftIds.forEach((id) => {
      const row = dbMap.get(id.slice(0, 32));
      if (row) {
        row.status = "active";
        const pda = pdaMap.get(id.slice(0, 32));
        if (pda) row.onChainPda = pda;
      }
    });
  }

  return records
    .map((onChain) => {
      const normalizedId = onChain.contentId.slice(0, 32);
      const dbRow = dbMap.get(normalizedId);

      // If no DB record exists, this PDA is orphaned (deleted from DB but still on-chain).
      // Skip it — the marketplace only shows content that has backend metadata.
      if (!dbRow) return null;

      // If the DB record explicitly marks it draft AND it's not being auto-synced,
      // keep it out of the public marketplace. Only the author sees drafts.
      if (dbRow.status === "draft") return null;

      // Old-format PDAs (created before author_nft_mint field was added) return basePrice=0
      // when parsed with the new Borsh layout. Fall back to DB for those fields.
      const isOldLayout = onChain.basePrice === 0n;

      return {
        contentId:    normalizedId,
        pdaAddress:   onChain.pdaAddress,
        title:        dbRow?.title        ?? `Content ${normalizedId.slice(0, 8)}`,
        description:  dbRow?.description  ?? undefined,
        category:     dbRow?.category     ?? "general",
        tags:         dbRow?.tags         ?? [],
        previewUri:   dbRow?.previewUri   ?? onChain.previewUri,
        authorWallet: onChain.primaryAuthor,
        basePrice:    isOldLayout ? String(dbRow?.basePrice ?? "0") : String(onChain.basePrice),
        paymentToken: onChain.paymentToken,
        license:      onChain.license,
        accessMint:   onChain.accessMint,
        mintAddress:  dbRow?.mintAddress  ?? null,
        onChainPda:   onChain.pdaAddress,
        storageUri:   onChain.storageUri,
        status:       "active",
        isActive:     true,
        // Prefer on-chain data for supply/royalty/min-royalty; fall back to DB for old-layout PDAs
        totalSupply:        (!isOldLayout && onChain.totalSupply > 0)      ? onChain.totalSupply     : (dbRow?.totalSupply  ?? undefined),
        availableSupply:    (!isOldLayout && onChain.availableSupply >= 0) ? onChain.availableSupply : undefined,
        royaltyBps:         (!isOldLayout && onChain.royaltyBps > 0)       ? onChain.royaltyBps      : (dbRow?.royaltyBps   ?? undefined),
        minRoyaltyLamports: isOldLayout ? 0 : Number(onChain.minRoyaltyLamports),
        // authorNftMint: trust on-chain only for new-format PDAs
        authorNftMint:      (!isOldLayout && onChain.authorNftMint && onChain.authorNftMint !== "pending")
                              ? onChain.authorNftMint
                              : (dbRow?.authorNftMint ?? undefined),
        soldCount:    dbRow?.soldCount    ?? 0,
        mimeType:     dbRow?.mimeType     ?? null,
        createdAt:    dbRow?.createdAt,
      } as EnrichedRecord;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null) as EnrichedRecord[];
}

/**
 * GET /api/v1/marketplace/stats
 *
 * Returns real-time aggregated statistics from the RegistryState PDA on Solana.
 * Falls back to DB counts if the PDA is not yet initialized.
 */
marketplaceRouter.get("/stats", async (c) => {
  const cacheKey = "marketplace:stats";
  const cached = await cacheGet<Record<string, unknown>>(cacheKey);
  if (cached) return c.json(cached);

  try {
    // Try to read from the on-chain RegistryState PDA first
    const onChain = await readRegistryState();

    if (onChain) {
      const stats = {
        source:             "chain",
        totalContent:       Number(onChain.totalContent),
        totalPurchases:     Number(onChain.totalPurchases),
        totalSecondarySales: Number(onChain.totalSecondarySales),
        totalSolVolumeLamports: String(onChain.totalSolVolume),
        totalSolVolumeSol:  (Number(onChain.totalSolVolume) / 1e9).toFixed(4),
      };
      await cacheSet(cacheKey, stats, 30); // 30s TTL for stats
      return c.json(stats);
    }
  } catch (err) {
    console.error("[marketplace/stats] chain read failed:", err);
  }

  // Fallback: count from DB
  const rows = await db
    .select({ contentId: content.contentId })
    .from(content)
    .where(eq(content.status, "active"));

  const stats = {
    source:             "db",
    totalContent:       rows.length,
    totalPurchases:     0,
    totalSecondarySales: 0,
    totalSolVolumeLamports: "0",
    totalSolVolumeSol:  "0.0000",
  };
  await cacheSet(cacheKey, stats, 30);
  return c.json(stats);
});

export { marketplaceRouter };
