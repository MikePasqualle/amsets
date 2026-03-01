# AMSETS — Test Report

> **Date:** March 1, 2026  
> **Environment:** Local development (Devnet)  
> **API:** http://localhost:3001  
> **Frontend:** http://localhost:3000

---

## Summary

| Category | Status |
|----------|--------|
| Infrastructure | ✅ All services running |
| Marketplace (public browse) | ✅ 5 items from on-chain |
| Content detail enrichment | ✅ All fields present |
| Auth protection | ✅ All protected endpoints return 401 before body validation |
| Secondary market listings | ✅ Endpoints work |
| On-chain stats (RegistryState) | ✅ Reading from Solana |
| Frontend pages | ✅ All 7 pages return 200 |
| Error handling | ✅ 404 and Unauthorized correct |
| Royalty calculation | ✅ Math verified |
| Smart contract deployed | ✅ Verified on Devnet |
| **Livepeer TUS upload** | ✅ **Fixed — `endpoint` replaces `uploadUrl`** |

---

## Test Results by Use Case

### USE CASE 1: Visitor browses marketplace
- **Status:** ✅ Pass
- **Source:** `chain` (Helius on-chain read)
- **Items:** 5 active, public content items
- All items have `status=active`, `isPrivate=false`
- No draft or private content leaks through

### USE CASE 2: Visitor views content detail
- **Status:** ✅ Pass
- All enriched fields present: `royaltyBps`, `totalSupply`, `availableSupply`, `authorNftMint`, `minRoyaltyLamports`, `basePrice`, `storageUri`
- Example response for "eee" content:
  - `royaltyBps: 1000` (10%)
  - `totalSupply: 100`
  - `availableSupply: 100`
  - `storageUri: livepeer://46935w85rc0hjh09`
  - `authorNftMint: 8mBu6Uuh1hauBjx6...`

### USE CASE 3: Minimum royalty validation
- **Status:** ✅ Pass
- Math verified for all cases:
  - `actual_royalty = max(price × royaltyBps / 10000, minRoyaltyLamports)`
  - `platform_fee = price × 250 / 10000 (2.5%)`
  - Listing requires: `price > actual_royalty + platform_fee`

### USE CASE 4: Auth protection
- **Status:** ✅ Pass
- `POST /content/register` → 401 without auth header
- `POST /livepeer/request-upload` → 401 without auth
- `GET /admin/stats` → 401 without admin key

### USE CASE 5: Secondary market listings
- **Status:** ✅ Pass (endpoints functional)
- `GET /listings/:contentId` returns `{ listings: [] }` when no active listings
- Create/cancel/fulfill endpoints exist and require auth

### USE CASE 6: Global statistics (RegistryState PDA)
- **Status:** ✅ Pass (reads from Solana on-chain)
- Source: `chain`
- Note: Existing content was registered with old contract version before RegistryState was added, so counters show 0. New publications will increment correctly.

### USE CASE 7: Frontend pages
- **Status:** ✅ All pass
- `/` — 200
- `/marketplace` — 200
- `/upload` — 200
- `/whitepaper` — 200
- `/my/content` — 200
- `/my/library` — 200
- `/my/wallet` — 200

### USE CASE 8: Error handling
- **Status:** ✅ Pass
- Non-existent content: `404 { "error": "Content not found" }`
- Unauthorized requests: `401 { "error": "Unauthorized" }`

---

## On-Chain Verification

| Check | Result |
|-------|--------|
| Contract deployed | ✅ `B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG` |
| ContentRecord PDAs exist | ✅ 556-byte accounts |
| RegistryState PDA exists | ✅ Found (41 bytes) |
| Helius RPC reads work | ✅ Verified |

---

## Known Issues & Notes

### ⚠️ Old-format PDA layout (informational, not blocking)

Existing content PDAs were registered with an older version of the `amsets-registry` contract that did not include the `author_nft_mint` field in the `ContentRecord` struct. When the new contract (which inserts `author_nft_mint` between `access_mint` and `base_price`) parses these old PDAs:
- `base_price` reads as 0 (actually reading the `author_nft_mint` position)
- `author_nft_mint` reads as garbage bytes

**Fix applied:** Backend detects old-format PDAs by checking if `basePrice === 0n` after parsing. For old PDAs, it falls back to PostgreSQL for all new fields (`royaltyBps`, `totalSupply`, `availableSupply`, `authorNftMint`). This is transparent to users.

**Long-term fix:** Re-publish content with the current contract version to get fully on-chain data for all fields.

### ⚠️ RegistryState counters show 0

The `RegistryState` PDA was initialized after the existing content PDAs were created. Existing purchases and registrations do not update these counters. All new activity (publish, buy, sell) will correctly increment them.

### ℹ️ Orphaned on-chain PDAs

Some old content PDAs exist on-chain but have no corresponding DB records (user deleted them from DB in a previous cleanup). The marketplace correctly filters these out — only content with both a PDA AND a DB record appears publicly.

---

## Fixes Applied During Testing

1. **`content.route.ts`** — Changed dynamic `import("../services/helius.service.js")` to static import at file top. The `.js` extension caused silent failures in ts-node.
2. **`content.route.ts`** — Added old-layout PDA detection (`basePrice === 0n`) with DB fallback for all enriched fields.
3. **`content.route.ts`** — Moved JWT auth check to middleware BEFORE `zValidator` so unauthenticated requests always return 401 (not 400 from body validation).
4. **`marketplace.route.ts`** — Added `authorNftMint` and `basePrice` to DB query. Added old-layout PDA detection.
5. **`marketplace.route.ts`** — Added filter: skip on-chain PDAs with no DB record (orphaned PDAs).
6. **`helius.service.ts`** — Modified `fetchAllContentRecords` to include old-format PDAs by checking `storageUri.length > 0` in addition to `isActive`.
7. **`listings.route.ts`** — Moved JWT auth middleware BEFORE `zValidator` on POST `/`, PATCH `/:id/sold`, and POST `/:id/fulfill`. All three now return 401 before body validation.
8. **`UploadSteps.tsx`** — **Critical fix**: Changed TUS upload from `uploadUrl: tusUploadUrl` to `endpoint: tusUploadUrl`. Livepeer's `tusEndpoint` is a **creation endpoint** (accepts POST to create a session, returns 201), not a resume URL. Using it as `uploadUrl` caused tus-js-client to send HEAD first → Livepeer returns 404 on fresh sessions → "unable to resume upload (new upload cannot be created without an endpoint)" error.

---

## Royalty Fee Distribution (Verified)

### Primary Sale (Author → Buyer)
```
Buyer pays: 1.0 SOL
  → 0.025 SOL (2.5%)  → FeeVault (platform)
  → 0.975 SOL (97.5%) → Author wallet
```

### Secondary Sale (Token Holder → New Buyer)
```
Buyer pays: 2.0 SOL, royalty=10%, min_royalty=0.05 SOL
  pct_royalty     = 2.0 × 10% = 0.20 SOL
  actual_royalty  = max(0.20, 0.05) = 0.20 SOL
  platform_fee    = 2.0 × 2.5% = 0.05 SOL
  seller_receives = 2.0 - 0.20 - 0.05 = 1.75 SOL
```
