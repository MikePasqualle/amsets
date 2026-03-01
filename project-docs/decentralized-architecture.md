# AMSETS — Decentralized Architecture (Phase 1-5 Implemented)

## Architecture Overview

```
User (browser)
    ↓
Next.js Frontend (localhost:3000)
    ├── Solana (ContentRecord PDA, AccessReceipt PDA) — primary source of truth
    ├── Arweave via Irys (ar://{txId} — AmsetsBundle JSON) — content + keys
    ├── Lit Protocol (datil-dev) — decentralized KMS
    ├── IPFS via Pinata — preview images
    └── Hono Backend (localhost:3001) — cache + IPFS proxy
           ├── Redis (5-min TTL)
           ├── PostgreSQL (cache / fallback)
           └── Helius API — on-chain indexer
```

---

## Data Architecture

### Arweave Content Bundle (`ar://{txId}`)

Every piece of content is stored as a single JSON document on Arweave.
This document contains EVERYTHING needed to access the content — no backend required.

```json
{
  "version": "1.0",
  "amsets": true,
  "metadata": {
    "title": "...",
    "description": "...",
    "category": "...",
    "mime_type": "video/mp4",
    "content_hash": "<sha256-hex>"
  },
  "preview_uri": "ipfs://...",
  "encrypted_payload": {
    "ciphertext_b64": "...",
    "iv_b64": "..."
  },
  "lit_bundle": {
    "ciphertext": "...",
    "data_to_encrypt_hash": "..."
  },
  "access": {
    "type": "sol_token_balance",
    "access_mint": "<SPL mint pubkey>"
  }
}
```

### Solana PDAs

| PDA | Seeds | Purpose |
|-----|-------|---------|
| `ContentRecord` | `["content", author, content_id_bytes]` | Content metadata + price |
| `AccessReceipt` | `["access", content_record_pda, buyer]` | Proof of purchase |
| `FeeVault` | `["fee_vault"]` | 2.5% protocol fee accumulation |

---

## Upload Flow (Decentralized)

```
1. User selects file
2. SHA-256 hash computed locally
3. AES-256-GCM encryption (browser, no server)
4. Lit Protocol encrypts AES key → AmsetsLitBundle
5. AmsetsBundle JSON assembled (metadata + encrypted payload + lit_bundle)
6. Bundle uploaded to Arweave via Irys → ar://{txId}
7. Preview image uploaded to IPFS (via backend proxy)
8. register_content(ar://{txId}, ...) on Solana → ContentRecord PDA created
9. Backend notified → caches metadata in PostgreSQL (WITHOUT encryptedKey)
```

**Key principle**: PostgreSQL does NOT store encryption keys. Keys are in Arweave.

---

## View Flow (Decentralized)

```
1. User navigates to content page
2. ContentViewer fetches ar://{txId} from Arweave gateway
3. Parses AmsetsBundle JSON → extracts lit_bundle + encrypted_payload
4. Lit Protocol decrypts AES key (checks: wallet holds access token)
5. AES-256-GCM decryption in browser
6. Content rendered via blob: URL (never persisted to disk)
```

**No backend involved in decryption.**

---

## Purchase Flow

```
1. User clicks "Purchase" on content page
2. ensureFeeVaultFunded() — funds vault if needed
3. purchase_access_sol transaction → AccessReceipt PDA created on-chain
4. Backend notified → caches purchase in PostgreSQL (non-fatal if fails)
5. User now has AccessReceipt PDA → Lit Protocol grants decryption access
```

---

## Library Flow (Phase 4)

Two-source merge:
1. **On-chain**: For each marketplace item, check `AccessReceipt PDA` existence
2. **Backend cache**: `GET /api/v1/content/library/:wallet` from PostgreSQL

Both sources merged and deduplicated by `contentId`.

---

## Marketplace Data Flow (Phase 3 — Helius-first)

```
Request
  ↓
Redis cache (5 min TTL) → return immediately
  ↓ (miss)
Helius API → getProgramAccounts(amsets_registry) → deserialize ContentRecord PDAs
  ↓ + enrich from PostgreSQL (title, description, preview)
  ↓ (Helius unavailable)
PostgreSQL fallback
```

### Helius Webhook

Register at https://dev.helius.xyz/dashboard:
- **URL**: `https://your-api.com/api/v1/webhook/helius`
- **Event**: `TRANSACTION`
- **Account**: `9KZywKubm7SfwBm8Zs3ZMgLD6tjxWDzmMK6yugz58Vst`
- **ENV**: Set `HELIUS_WEBHOOK_SECRET` for verification

---

## API Endpoints

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/v1/marketplace` | Content list (Helius-first) |
| `GET` | `/api/v1/content/:id` | Single content metadata |
| `GET` | `/api/v1/webhook/helius` | Webhook health check |

### Authenticated (Bearer JWT)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/content/register` | Register new content in cache |
| `PATCH` | `/api/v1/content/:id/publish` | Promote draft → active |
| `GET` | `/api/v1/content/by-author/:wallet` | Author's content |
| `GET` | `/api/v1/content/library/:wallet` | Purchased content |
| `POST` | `/api/v1/purchases` | Cache on-chain purchase |
| `GET` | `/api/v1/purchases/my` | User's purchase history |
| `POST` | `/api/v1/upload/preview` | Proxy image to Pinata |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/webhook/helius` | Helius transaction events |

---

## Frontend Key Files

| File | Purpose |
|------|---------|
| `lib/anchor.ts` | Solana helpers: publishOnChain, purchaseAccess, deriveAccessReceiptPda, ensureFeeVaultFunded |
| `lib/arweave-bundle.ts` | AmsetsBundle encode/decode |
| `lib/storage.ts` | uploadBundleToArweave, uploadToArweave |
| `lib/lit.ts` | Lit Protocol v7 encrypt/decrypt |
| `lib/crypto.ts` | AES-256-GCM key ops |
| `components/content/UploadSteps.tsx` | 5-step upload wizard |
| `components/content/ContentViewer.tsx` | Secure decrypted content viewer |
| `components/content/ContentPageClient.tsx` | Content page with real purchase |
| `components/content/LibraryClient.tsx` | On-chain + cached library |

---

## Environment Variables Required

### Backend (`amsets-api/.env`)

```bash
DATABASE_URL=postgresql://amsets:password@localhost:5432/amsets_db
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_secret_here
CONTENT_JWT_SECRET=your_content_secret_here
PINATA_JWT=your_pinata_jwt_here
HELIUS_API_KEY=your_helius_api_key           # from https://dev.helius.xyz
HELIUS_WEBHOOK_SECRET=your_webhook_secret    # optional
SOLANA_CLUSTER=devnet
```

### Frontend (`amsets-app/.env.local`)

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_SOLANA_RPC=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
NEXT_PUBLIC_ARWEAVE_GATEWAY=https://arweave.net
NEXT_PUBLIC_IRYS_NETWORK=devnet
NEXT_PUBLIC_LIT_NETWORK=datil-dev
NEXT_PUBLIC_PINATA_GATEWAY=https://gateway.pinata.cloud
NEXT_PUBLIC_WEB3AUTH_CLIENT_ID=your_web3auth_client_id
```

---

## Verification Checkpoints

### Phase 0 ✅
- `anchor.ts`: `purchaseAccess()`, `deriveAccessReceiptPda()`, `ensureFeeVaultFunded()` implemented
- `ContentPageClient.tsx`: real purchase transaction with AccessReceipt PDA check

### Phase 1 ✅
- `arweave-bundle.ts`: `encodeBundle()` / `decodeBundle()`
- `storage.ts`: `uploadBundleToArweave()` for JSON bundle upload
- `UploadSteps.tsx`: Arweave → IPFS → Solana → backend order
- `ContentViewer.tsx`: reads from Arweave bundle (no backend for decryption)
- `content.route.ts`: `encrypted_key` optional (stored in Arweave bundle)
- `schema.ts`: `encryptedKey` / `litConditionsHash` nullable

### Phase 2 ✅
- `lit.ts`: v7 API (`client.encrypt()`, `client.decrypt()`)
- `buildSolanaACCs()` uses real `accessMint`
- `buildReceiptACCs()` fallback via AccessReceipt PDA balance check

### Phase 3 ✅
- `helius.service.ts`: Borsh deserialization of ContentRecord PDAs
- `webhook.route.ts`: Helius webhook handler with cache invalidation
- `marketplace.route.ts`: Helius-first, PostgreSQL fallback

### Phase 4 ✅
- `LibraryClient.tsx`: reads AccessReceipt PDAs from Solana + backend cache merge
- `purchases.route.ts`: POST /purchases (idempotent cache write)

### Phase 5 ✅ — Minimum Royalty Feature (2026-02-21)
**Smart Contract (`lib.rs`):**
- New `min_royalty_lamports: u64` field in `ContentRecord` (Borsh offset: after `royalty_bps`)
- `register_content` instruction now accepts `min_royalty_lamports` parameter (default 0)
- `create_listing` validates `price > max(royalty_bps%, min_royalty_lamports) + platform_fee`; rejects with `PriceBelowMinRoyalty` error if too low — fully decentralized, no trusted middleman
- `execute_sale` computes `royalty = max(pct_royalty, min_royalty_lamports)` — author always receives the higher of the two
- `ContentRecord.MAX_SIZE` updated to 614 bytes (+8 for new u64 field)
- New error variant: `PriceBelowMinRoyalty`
- Deployed to Devnet: `B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG`

**Frontend (`anchor.ts`):**
- `RegisterContentArgs.minRoyaltyLamports: bigint` added
- `buildRegisterContentData` appends 8-byte u64 LE at end of instruction data
- `PublishOnChainParams.minRoyaltyLamports?: bigint` added
- `createListingOnChain` now requires `contentRecordPdaStr` (3rd arg) and passes it as the `content_record` account key for on-chain validation

**Upload Wizard (`UploadSteps.tsx`):**
- New "Min. Royalty (SOL)" input field in Step 3 (Pricing), default "0"
- Converted to lamports and passed to `publishOnChain` as `minRoyaltyLamports`
- Help text explains the floor is enforced on-chain

**Content Page (`ContentPageClient.tsx`):**
- `ContentItem.minRoyaltyLamports?: number` added
- Shows author's minimum royalty + computed minimum listing price when floor > 0
- Live payout preview uses `max(royalty_bps%, min_royalty_lamports)` for royalty display
- "Confirm Listing" button disabled if entered price is below minimum
- Resale listing fee breakdown correctly reflects the floor royalty
- `createListingOnChain` called with `content.onChainPda` as 3rd argument

**Backend:**
- `helius.service.ts`: `OnChainContentRecord.minRoyaltyLamports: bigint` added; deserialized from last 8 bytes of ContentRecord
- `marketplace.route.ts`: `minRoyaltyLamports` included in `EnrichedRecord` and marketplace response
- `content.route.ts`: `registerSchema` accepts `min_royalty_lamports`; `GET /:id` enriches with on-chain `minRoyaltyLamports`

---

## Known Limitations (Production Checklist)

1. **Fee vault**: Must be funded before first purchase. `ensureFeeVaultFunded()` handles this automatically.
2. **Arweave propagation**: New bundles take ~10 minutes to propagate to all gateways. Preview may show "pending" briefly.
3. **Lit Protocol access mint**: Currently uses placeholder `11111111111111111111111111111111` — to enable real token-gating, implement `createAccessMint()` with `@solana/spl-token`.
4. **Helius HELIUS_API_KEY**: Without this key, marketplace falls back to PostgreSQL only.
5. **Content viewer**: Requires Phantom/Solflare for Lit Protocol signing. Web3Auth users can browse but not decrypt.
