ALTER TYPE "public"."content_status" ADD VALUE 'draft' BEFORE 'active';--> statement-breakpoint
ALTER TYPE "public"."content_status" ADD VALUE 'archived' BEFORE 'inactive';--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" text NOT NULL,
	"seller_wallet" text NOT NULL,
	"price_lamports" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mint_address" text,
	"token_account" text,
	"on_chain_listing_pda" text,
	"escrow_ata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content" ALTER COLUMN "encrypted_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content" ALTER COLUMN "lit_conditions_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "total_supply" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "royalty_bps" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "mint_address" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "author_nft_mint" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "sold_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "listings_content_idx" ON "listings" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "listings_seller_idx" ON "listings" USING btree ("seller_wallet");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status");