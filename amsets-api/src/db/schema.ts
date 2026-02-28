import {
  pgTable,
  text,
  boolean,
  bigint,
  integer,
  timestamp,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const authMethodEnum = pgEnum("auth_method", [
  "web3auth_email",
  "web3auth_phone",
  "web3auth_google",
  "web3auth_apple",
  "wallet_adapter",
]);

export const paymentTokenEnum = pgEnum("payment_token", ["SOL", "USDC"]);

export const licenseEnum = pgEnum("license_terms", [
  "personal",
  "commercial",
  "derivative",
  "unlimited",
]);

export const contentStatusEnum = pgEnum("content_status", [
  "draft",    // registered in AMSETS, not yet deployed on-chain
  "active",   // deployed on Solana — publicly published
  "archived", // soft-deleted by author
  "inactive", // legacy — kept for backwards compatibility
  "pending",  // legacy — kept for backwards compatibility
]);

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Users — one row per unique wallet address.
 * A wallet may be created by Web3Auth (MPC) or brought by the user (Phantom etc.)
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAddress: text("wallet_address").notNull(),
    authMethod: authMethodEnum("auth_method").notNull(),
    email: text("email"),
    phone: text("phone"),
    username: text("username"),
    avatarUrl: text("avatar_url"),
    isOnChainAccountOpened: boolean("is_on_chain_account_opened")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    walletIdx: uniqueIndex("users_wallet_idx").on(t.walletAddress),
    emailIdx: index("users_email_idx").on(t.email),
  })
);

/**
 * Content — each registered IP asset on Arweave + Solana.
 */
export const content = pgTable(
  "content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentId: text("content_id").notNull(), // on-chain UUID (hex)
    authorWallet: text("author_wallet").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category"),
    tags: text("tags").array(),
    storageUri: text("storage_uri").notNull(), // "ar://{txId}"
    previewUri: text("preview_uri").notNull(), // "ipfs://{cid}"
    contentHash: text("content_hash").notNull(), // SHA-256 hex
    accessMint: text("access_mint").notNull(), // SPL mint address
    onChainPda: text("on_chain_pda").notNull(), // ContentRecord PDA
    basePrice: bigint("base_price", { mode: "bigint" }).notNull(), // lamports
    paymentToken: paymentTokenEnum("payment_token").notNull().default("SOL"),
    license: licenseEnum("license").notNull().default("personal"),
    status: contentStatusEnum("status").notNull().default("active"),
    // Lit Protocol data (legacy fallback — Phase 1+ stores these in the Arweave bundle).
    // Nullable: new content uploaded via Phase 1 flow does NOT store keys in PostgreSQL.
    encryptedKey: text("encrypted_key"),
    litConditionsHash: text("lit_conditions_hash"),
    // Token system fields (Phase 2)
    totalSupply:  integer("total_supply").notNull().default(1),   // tokens available for sale
    royaltyBps:   integer("royalty_bps").notNull().default(1000), // 1000 = 10%
    mintAddress:  text("mint_address"),   // SPL Token-2022 mint pubkey (set after mint creation)
    soldCount:    integer("sold_count").notNull().default(0),
    mimeType:     text("mime_type"),      // original file MIME type
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    contentIdIdx: uniqueIndex("content_content_id_idx").on(t.contentId),
    authorIdx: index("content_author_idx").on(t.authorWallet),
    categoryIdx: index("content_category_idx").on(t.category),
    statusIdx: index("content_status_idx").on(t.status),
  })
);

/**
 * Purchases — records each successful content purchase transaction.
 */
export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentId: text("content_id").notNull(),
    buyerWallet: text("buyer_wallet").notNull(),
    authorWallet: text("author_wallet").notNull(),
    accessMint: text("access_mint").notNull(),
    txSignature: text("tx_signature").notNull(),
    amountPaid: bigint("amount_paid", { mode: "bigint" }).notNull(),
    paymentToken: paymentTokenEnum("payment_token").notNull(),
    purchasedAt: timestamp("purchased_at").notNull().defaultNow(),
  },
  (t) => ({
    txSigIdx: uniqueIndex("purchases_tx_sig_idx").on(t.txSignature),
    buyerIdx: index("purchases_buyer_idx").on(t.buyerWallet),
    contentIdx: index("purchases_content_idx").on(t.contentId),
  })
);

/**
 * Listings — access tokens listed for resale on the AMSETS marketplace.
 *
 * Lifecycle: active → sold | cancelled
 * When a buyer purchases a listing, the access token is transferred from the
 * seller to the buyer (Token-2022 transfer with automatic royalty deduction),
 * SOL is transferred to the seller, and status is set to "sold".
 */
export const listings = pgTable(
  "listings",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    contentId:     text("content_id").notNull(),        // AMSETS content UUID
    sellerWallet:  text("seller_wallet").notNull(),     // seller's Solana pubkey
    priceLamports: bigint("price_lamports", { mode: "bigint" }).notNull(),
    status:        text("status").notNull().default("active"), // active | sold | cancelled
    mintAddress:   text("mint_address").notNull(),      // SPL Token-2022 mint
    tokenAccount:  text("token_account"),               // seller's ATA holding the token
    createdAt:     timestamp("created_at").notNull().defaultNow(),
    updatedAt:     timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    contentIdx: index("listings_content_idx").on(t.contentId),
    sellerIdx:  index("listings_seller_idx").on(t.sellerWallet),
    statusIdx:  index("listings_status_idx").on(t.status),
  })
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Content = typeof content.$inferSelect;
export type NewContent = typeof content.$inferInsert;
export type Purchase = typeof purchases.$inferSelect;
export type NewPurchase = typeof purchases.$inferInsert;
export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
