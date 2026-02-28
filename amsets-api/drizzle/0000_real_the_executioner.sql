CREATE TYPE "public"."auth_method" AS ENUM('web3auth_email', 'web3auth_phone', 'web3auth_google', 'web3auth_apple', 'wallet_adapter');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('active', 'inactive', 'pending');--> statement-breakpoint
CREATE TYPE "public"."license_terms" AS ENUM('personal', 'commercial', 'derivative', 'unlimited');--> statement-breakpoint
CREATE TYPE "public"."payment_token" AS ENUM('SOL', 'USDC');--> statement-breakpoint
CREATE TABLE "content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" text NOT NULL,
	"author_wallet" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"tags" text[],
	"storage_uri" text NOT NULL,
	"preview_uri" text NOT NULL,
	"content_hash" text NOT NULL,
	"access_mint" text NOT NULL,
	"on_chain_pda" text NOT NULL,
	"base_price" bigint NOT NULL,
	"payment_token" "payment_token" DEFAULT 'SOL' NOT NULL,
	"license" "license_terms" DEFAULT 'personal' NOT NULL,
	"status" "content_status" DEFAULT 'active' NOT NULL,
	"encrypted_key" text NOT NULL,
	"lit_conditions_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" text NOT NULL,
	"buyer_wallet" text NOT NULL,
	"author_wallet" text NOT NULL,
	"access_mint" text NOT NULL,
	"tx_signature" text NOT NULL,
	"amount_paid" bigint NOT NULL,
	"payment_token" "payment_token" NOT NULL,
	"purchased_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"auth_method" "auth_method" NOT NULL,
	"email" text,
	"phone" text,
	"username" text,
	"avatar_url" text,
	"is_on_chain_account_opened" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_content_id_idx" ON "content" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "content_author_idx" ON "content" USING btree ("author_wallet");--> statement-breakpoint
CREATE INDEX "content_category_idx" ON "content" USING btree ("category");--> statement-breakpoint
CREATE INDEX "content_status_idx" ON "content" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_tx_sig_idx" ON "purchases" USING btree ("tx_signature");--> statement-breakpoint
CREATE INDEX "purchases_buyer_idx" ON "purchases" USING btree ("buyer_wallet");--> statement-breakpoint
CREATE INDEX "purchases_content_idx" ON "purchases" USING btree ("content_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_wallet_idx" ON "users" USING btree ("wallet_address");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");