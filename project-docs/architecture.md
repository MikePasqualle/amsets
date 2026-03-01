# AMSETS — Architecture & Use-Case Reference

> **Version:** 1.0 — February 2026  
> **Network:** Solana Devnet (dev) / Mainnet-Beta (prod)  
> **Program ID:** `B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG`

---

## 1. System Overview

AMSETS is a **fully decentralized digital-rights ledger** built on Solana. The rule is simple:

> _Everything that matters lives on-chain. The backend and frontend are just caches and gateways — any alternative frontend can connect directly to the same smart contract._

```
┌──────────────────────────────────────────────────────────────────┐
│                       AMSETS System                              │
│                                                                  │
│  ┌───────────┐    ┌──────────────┐    ┌───────────────────────┐ │
│  │  Browser  │───▶│  Next.js     │───▶│  Hono API (Node.js)   │ │
│  │  Frontend │    │  (Port 3000) │    │  (Port 3001)          │ │
│  └─────┬─────┘    └──────────────┘    └──────────┬────────────┘ │
│        │                                          │              │
│        │  (wallet signs txs)                      │  (reads DB,  │
│        │                                          │   cache,     │
│        ▼                                          │   enriches)  │
│  ┌──────────────────────────────────────────┐     │              │
│  │           Solana Blockchain              │◀────┘              │
│  │                                          │                    │
│  │  Program: amsets-registry               │                    │
│  │  ┌─────────────────────────────────┐    │                    │
│  │  │  ContentRecord PDA              │    │                    │
│  │  │  ListingRecord PDA              │    │                    │
│  │  │  AccessReceipt PDA              │    │                    │
│  │  │  FeeVault PDA                   │    │                    │
│  │  │  RegistryState PDA (stats)      │    │                    │
│  │  └─────────────────────────────────┘    │                    │
│  └──────────────────────────────────────────┘                   │
│                                                                  │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────────────────┐  │
│  │  PostgreSQL  │  │   Redis   │  │  Livepeer.studio          │  │
│  │  (metadata)  │  │  (cache)  │  │  (video storage/CDN)      │  │
│  └──────────────┘  └───────────┘  └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. On-Chain Data Model

### PDAs (Program Derived Addresses)

| PDA | Seeds | Purpose |
|-----|-------|---------|
| `ContentRecord` | `["content", author_pubkey, content_id]` | All metadata, supply, royalty settings |
| `AccessReceipt` | `["access", content_record_key, buyer_pubkey]` | Proof of primary purchase |
| `ListingRecord` | `["listing", listing_id_bytes]` | Secondary market listing |
| `FeeVault` | `["fee_vault"]` | Protocol commission collector |
| `RegistryState` | `["registry"]` | Global stats (total content, purchases, volume) |

### ContentRecord fields (Borsh layout)

```
content_id[32]          — 16-byte UUID (hex)
content_hash[32]        — SHA-256 of original file
storage_uri             — "livepeer://{playbackId}"
preview_uri             — "ipfs://{cid}"
primary_author[32]      — author's wallet
access_mint[32]         — SPL mint for access tokens
author_nft_mint[32]     — 1-of-1 authorship NFT mint
base_price[8]           — price in lamports (SOL)
payment_token[1]        — 0=SOL, 1=USDC
license[1]              — 0=Personal, 1=Commercial …
is_active[1]
bump[1]
total_supply[4]         — max access tokens to ever exist
available_supply[4]     — remaining (decrements on purchase)
royalty_bps[2]          — 0-5000 (max 50%) secondary royalty %
min_royalty_lamports[8] — floor royalty in lamports (0 = % only)
```

---

## 3. Token Model

```
                    Content Upload
                         │
                         ▼
            ┌────────────────────────┐
            │   Author NFT Mint      │   ← 1-of-1 (supply = 1)
            │   (Authorship Token)   │   ← Minted to author at publish
            │                        │   ← Whoever holds it = royalty receiver
            └────────────────────────┘
                         │
                         │  (separate mint)
                         ▼
            ┌────────────────────────┐
            │   Access Token Mint    │   ← Fungible, supply = author-defined
            │   (e.g. 100 tokens)    │   ← 1 token = 1 access pass
            │                        │   ← Minted on each primary purchase
            └────────────────────────┘
```

**Two-token model rules:**
- The **Author NFT** can be sold/transferred — whoever holds it receives all future royalties
- **Access Tokens** gate content viewing — if balance ≥ 1, user can view
- Burning an Access Token removes viewing access
- Tokens can be re-sold on the secondary market (escrow system)

---

## 4. Technical Architecture — Layer by Layer

### Layer 1: Blockchain (Source of Truth)

```
┌─────────────────────────────────────────────────────────────────┐
│  amsets-registry smart contract                                  │
│                                                                  │
│  Instructions:                                                   │
│  ┌──────────────────────┐  ┌───────────────────────────────┐    │
│  │  initialize_registry │  │  register_content             │    │
│  │  initialize_vault    │  │  set_access_mint              │    │
│  └──────────────────────┘  │  set_author_nft_mint          │    │
│                             │  purchase_access_sol          │    │
│  ┌──────────────────────┐   │  mint_access_token           │    │
│  │  create_listing      │   └───────────────────────────────┘    │
│  │  cancel_listing      │                                        │
│  │  execute_sale        │   Global RegistryState:               │
│  └──────────────────────┘   - total_content                     │
│                             - total_purchases                    │
│                             - total_secondary_sales             │
│                             - total_sol_volume                   │
└─────────────────────────────────────────────────────────────────┘
```

### Layer 2: Backend API (Hono + Node.js)

```
┌──────────────────────────────────────────────────────────┐
│  API Routes                                               │
│                                                           │
│  /api/v1/content        — register, fetch, enrich        │
│  /api/v1/marketplace    — list active content + stats    │
│  /api/v1/listings       — secondary market CRUD          │
│  /api/v1/livepeer       — upload URLs + playback JWT     │
│  /api/v1/purchases      — purchase history               │
│  /api/v1/auth           — JWT auth                       │
│  /api/v1/admin          — admin settings + stats         │
│                                                           │
│  Services:                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ helius.svc   │  │ livepeer.svc │  │ minting logic  │ │
│  │ (DAS API     │  │ (upload,     │  │ (Author NFT,   │ │
│  │  on-chain    │  │  JWT sign)   │  │  Access Token) │ │
│  │  reads)      │  └──────────────┘  └────────────────┘ │
│  └──────────────┘                                        │
│                                                           │
│  Storage:  PostgreSQL (metadata) + Redis (60s cache)     │
└──────────────────────────────────────────────────────────┘
```

### Layer 3: Frontend (Next.js App Router)

```
┌──────────────────────────────────────────────────────────┐
│  Pages                                                    │
│                                                           │
│  /               — Homepage (latest 4 + stats)           │
│  /marketplace    — All content, search + filters         │
│  /c/[id]         — Content detail, buy, list for sale    │
│  /upload         — Multi-step publish wizard             │
│  /my/content     — My published works                    │
│  /my/library     — Purchased content                     │
│  /my/wallet      — Token management (burn, cleanup)      │
│  /my/settings    — Profile settings                      │
│  /whitepaper     — Project whitepaper                    │
│  /admin/settings — Admin controls                        │
│                                                           │
│  Auth:                                                   │
│  ┌─────────────────────┐  ┌─────────────────────────┐   │
│  │ Web3Auth (email,    │  │ Wallet Adapter           │   │
│  │ phone, Google)      │  │ (Phantom, Solflare)      │   │
│  └─────────────────────┘  └─────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Layer 4: Storage

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│  Video files  ──▶  Livepeer.studio  ──▶  HLS streaming (CDN)   │
│                    (TUS chunked                                  │
│                     upload, up to                                │
│                     10 GB)                                       │
│                                                                  │
│  Previews     ──▶  IPFS via Pinata  ──▶  ipfs://{cid}          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Use Cases — All Roles

### Role 1: Author (Content Creator)

```
┌─────────────────────────────────────────────────────────┐
│  AUTHOR JOURNEY                                          │
│                                                          │
│  1. Connect wallet (Phantom / Solflare / Web3Auth email)│
│  2. Click "Publish" → Upload wizard:                    │
│     Step 1: Drag & drop video file (up to 10 GB)        │
│             ↓ TUS chunked upload → Livepeer.studio      │
│     Step 2: Enter title, description, category, tags   │
│             Upload preview image → IPFS (Pinata)        │
│     Step 3: Set price in SOL, total token supply,       │
│             royalty % (0–50%), min royalty SOL floor    │
│     Step 4: Sign 5 transactions:                        │
│             a) register_content (ContentRecord PDA)      │
│             b) set_access_mint (link access token)       │
│             c) set_author_nft_mint (link author NFT)    │
│             d) Backend mints Author NFT to author wallet│
│             e) Backend calls set_access_mint on-chain   │
│  3. Content appears as "active" on marketplace          │
│  4. Author can view content immediately (owns NFT)      │
│                                                          │
│  Revenue streams:                                        │
│  - Primary sale: full base_price (no royalty deducted)  │
│  - Secondary sales: royalty = max(royalty_bps%, min_sol)│
│    credited to current Author NFT holder's wallet       │
│                                                          │
│  Author NFT can be sold → royalties go to new holder    │
└─────────────────────────────────────────────────────────┘
```

**SOL needed by author:**
- ~0.002–0.005 SOL per transaction × 5 = ~0.01–0.025 SOL for publishing

---

### Role 2: Buyer (Primary Market)

```
┌─────────────────────────────────────────────────────────┐
│  BUYER JOURNEY (Primary Market)                          │
│                                                          │
│  1. Browse marketplace at / or /marketplace             │
│  2. Click content card → /c/[id]                        │
│  3. See: preview, description, price, royalty info,     │
│          available supply, all secondary listings       │
│  4. Connect wallet if not connected                     │
│  5. Click "Buy Access"                                  │
│     a) purchase_access_sol transaction (user signs):    │
│        - SOL sent: base_price                           │
│        - Distribution:                                  │
│          ├─ 2.5% → FeeVault (platform)                 │
│          └─ 97.5% → author wallet                       │
│        - available_supply decremented on-chain          │
│        - AccessReceipt PDA created                      │
│     b) Backend mints 1 Access Token to buyer's wallet  │
│  6. Content unlocked — video playback starts           │
│  7. Token visible in /my/library and /my/wallet         │
└─────────────────────────────────────────────────────────┘
```

**Primary sale fee breakdown:**
```
Price: 1.0 SOL
  → 0.025 SOL (2.5%) to Platform FeeVault
  → 0.975 SOL (97.5%) to Author
```

---

### Role 3: Token Holder (Secondary Market Seller)

```
┌─────────────────────────────────────────────────────────┐
│  SELLER JOURNEY (Secondary Market)                       │
│                                                          │
│  Pre-condition: user holds ≥ 1 Access Token             │
│                                                          │
│  1. Open content page /c/[id]                          │
│  2. "List for Sale" panel appears (if holder)           │
│  3. Enter listing price in SOL                          │
│     UI shows:                                           │
│     - Minimum listing price (computed from min_royalty) │
│     - Live payout breakdown:                            │
│       ├─ Platform fee: 2.5%                             │
│       ├─ Author royalty: max(royalty_bps%, min_sol)     │
│       └─ Seller receives: remainder                     │
│     - "Confirm" disabled if price < minimum             │
│  4. Click "List" → Transactions:                        │
│     a) create_listing (user signs):                     │
│        - On-chain validation: price > royalty + fee     │
│        - ListingRecord PDA created on Solana            │
│     b) Backend API POST /api/v1/listings:               │
│        - Token transferred to escrow ATA (via           │
│          PermanentDelegate, backend signs)              │
│  5. Listing visible to all buyers on content page      │
│  6. Seller can cancel listing any time (token returned) │
└─────────────────────────────────────────────────────────┘
```

---

### Role 4: Secondary Market Buyer

```
┌─────────────────────────────────────────────────────────┐
│  BUYER JOURNEY (Secondary Market)                        │
│                                                          │
│  1. Open content page /c/[id]                          │
│  2. See "Available Resale Listings" with prices         │
│  3. Click "Buy" on a specific listing                   │
│  4. Transactions:                                       │
│     a) execute_sale (user/buyer signs):                 │
│        - SOL distribution:                              │
│          ├─ 2.5% → FeeVault (platform)                 │
│          ├─ max(royalty_bps%, min_sol) → Author NFT     │
│          │   holder's wallet                           │
│          └─ Remainder → Seller wallet                   │
│        - ListingRecord status updated to "sold"         │
│     b) Backend POST /api/v1/listings/:id/fulfill:       │
│        - Access Token moved from escrow ATA to buyer    │
│          wallet (PermanentDelegate, backend signs)      │
│        - Seller's token burned/removed from escrow      │
│  5. Buyer now has 1 Access Token → can view content    │
│  6. RegistryState.total_secondary_sales incremented     │
└─────────────────────────────────────────────────────────┘
```

**Secondary sale fee breakdown (example):**
```
Listing price: 2.0 SOL, royalty: 10%, min_royalty: 0.05 SOL
  pct_royalty = 2.0 × 10% = 0.20 SOL
  actual_royalty = max(0.20, 0.05) = 0.20 SOL
  platform_fee = 2.0 × 2.5% = 0.05 SOL
  seller_receives = 2.0 - 0.20 - 0.05 = 1.75 SOL
```

---

### Role 5: Platform Admin

```
┌─────────────────────────────────────────────────────────┐
│  ADMIN CAPABILITIES                                      │
│                                                          │
│  Access: /admin/settings (requires ADMIN_SECRET header) │
│                                                          │
│  Settings:                                              │
│  - View platform stats (total content, purchases,       │
│    volume from both DB and on-chain)                    │
│  - Configure platform fee recipient address             │
│  - Manage content moderation                            │
│                                                          │
│  On-chain admin:                                        │
│  - FeeVault collects 2.5% of all sales                 │
│  - Program authority can withdraw from FeeVault         │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Full Publish Flow (Sequence Diagram)

```
Author          Frontend         Backend API       Solana Blockchain
  │                │                 │                    │
  │──drag file────▶│                 │                    │
  │                │──POST /livepeer/request-upload───▶   │
  │                │◀──{tusUploadUrl, playbackId}──────   │
  │                │──TUS chunk upload to Livepeer CDN──▶ Livepeer
  │                │◀──upload complete──────────────────  Livepeer
  │                │                 │                    │
  │──fill details──▶│                │                    │
  │──sign tx (1)───▶│──buildRegisterContentData──────────▶│
  │                │                 │  ContentRecord PDA  │
  │                │◀──signature─────────────────────────  │
  │                │                 │                    │
  │                │──POST /content/register─────────▶   │
  │                │◀──{contentId}──────────────────────  │
  │                │                 │                    │
  │                │──POST /content/:id/create-mint─▶    │
  │                │◀──{accessMint, authorNftMint}──────  │
  │                │                 │                    │
  │──sign tx (2)───▶│──set_access_mint───────────────────▶│
  │◀──confirmed────│                 │                    │
  │──sign tx (3)───▶│──set_author_nft_mint───────────────▶│
  │◀──confirmed────│                 │                    │
  │                │──POST /content/:id/mint-author-nft─▶ │
  │◀──Author NFT in wallet────────────────────────────── Backend mints
  │                │                 │                    │
  │                │──PATCH /content/:id/publish────▶    │
  │                │  (status=active, onChainPda=...)    │
  │                │◀──OK───────────────────────────────  │
  │◀──redirect /my/content──────────│                    │
```

---

## 7. Primary Purchase Flow

```
Buyer           Frontend         Backend API       Solana Blockchain
  │                │                 │                    │
  │──click Buy────▶│                 │                    │
  │                │──GET /content/:id/royalty-holder─▶  │
  │                │◀──{royaltyHolder: pubkey}───────────  │
  │                │                 │                    │
  │──sign tx──────▶│──purchase_access_sol───────────────▶│
  │                │  (buyer pays SOL, author receives,  │
  │                │   vault gets 2.5%)                  │
  │◀──confirmed────│                 │                    │
  │                │                 │                    │
  │                │──POST /content/:id/mint-token──▶    │
  │                │   (Backend mints 1 access token     │
  │                │    to buyer wallet via authority)   │
  │◀──Token in wallet──────────────────────────────────  │
  │◀──Content unlocked─────────────────────────────────  │
```

---

## 8. Secondary Market Flow

```
Seller          Frontend         Backend API       Solana Blockchain
  │                │                 │                    │
  │──enter price──▶│                 │                    │
  │                │  validates: price > royalty + fee    │
  │──sign tx──────▶│──create_listing───────────────────▶│
  │                │  (on-chain validation, ListingRecord)│
  │◀──confirmed────│                 │                    │
  │                │──POST /api/v1/listings──────────▶   │
  │                │   (Backend moves token to escrow    │
  │                │    via PermanentDelegate)           │
  │◀──Listed!──────│                 │                    │
                                                          
Buyer           Frontend         Backend API       Solana Blockchain
  │                │                 │                    │
  │──click Buy────▶│                 │                    │
  │──sign tx──────▶│──execute_sale─────────────────────▶│
  │                │  (SOL split: platform/author/seller) │
  │◀──confirmed────│                 │                    │
  │                │──POST /listings/:id/fulfill────▶    │
  │                │   (Backend moves token escrow→buyer  │
  │                │    via PermanentDelegate)            │
  │◀──Token received─────────────────────────────────── │
  │◀──Content unlocked──────────────────────────────── │
```

---

## 9. Access Control Summary

| User | Can view content? | Can list for sale? | Can cancel listing? |
|------|:-----------------:|:-----------------:|:------------------:|
| Author (holds Author NFT) | ✅ Always | ✅ If holds Access Token | ✅ Own listings only |
| Access Token holder | ✅ Yes | ✅ Yes | ✅ Own listings only |
| Non-holder (no token) | ❌ Blurred | ❌ No | ❌ No |
| Author (no Access Token) | ✅ Yes (Author NFT) | ❌ No | ✅ Own listings only |

---

## 10. SOL Requirements Summary

| Action | Who pays | Approx. cost |
|--------|----------|-------------|
| Publish content (5 txs) | Author | ~0.025 SOL |
| Primary purchase | Buyer | base_price + ~0.002 SOL tx fee |
| List for sale | Seller | ~0.002 SOL tx fee |
| Cancel listing | Seller | ~0.002 SOL tx fee |
| Buy on secondary | Buyer | listing_price + ~0.002 SOL tx fee |
| Burn token | Token holder | ~0.001 SOL tx fee |
| Backend mint authority | Backend wallet | Must keep ≥ 0.1 SOL |

---

## 11. API Endpoints Reference

### Public (no auth required)
```
GET  /api/v1/marketplace              — list active content
GET  /api/v1/marketplace/stats        — on-chain global stats
GET  /api/v1/content/:id              — content detail (enriched with on-chain data)
GET  /api/v1/listings/:contentId      — active resale listings for content
```

### Authenticated (JWT required)
```
POST /api/v1/content/register         — register content metadata
POST /api/v1/content/:id/create-mint  — create Author NFT + Access mint
POST /api/v1/content/:id/mint-token   — mint access token to buyer
POST /api/v1/livepeer/request-upload  — get TUS upload URL from Livepeer
GET  /api/v1/livepeer/playback-jwt/:contentId — signed JWT for video playback
POST /api/v1/listings                 — create listing, move token to escrow
DELETE /api/v1/listings/:id           — cancel listing, return token
POST /api/v1/listings/:id/fulfill     — complete sale, move token to buyer
GET  /api/v1/content/:id/royalty-holder — current Author NFT holder
PATCH /api/v1/content/:id/publish     — mark content active with PDA
```

### Admin (X-Admin-Secret header)
```
GET  /api/v1/admin/settings
GET  /api/v1/admin/stats
```

---

## 12. Environment Variables Required

### Backend (`amsets-api/.env`)
```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
HELIUS_API_KEY=...            # Solana RPC + DAS API
MINT_AUTHORITY_SECRET=[...]   # JSON keypair array — mints tokens
PROGRAM_ID=B2gRbiH...
LIVEPEER_API_KEY=...          # Studio API key
LIVEPEER_PRIVATE_KEY=...      # ES256 key for JWT signing
JWT_SECRET=...
ADMIN_SECRET=...
PLATFORM_FEE_BPS=250
```

### Frontend (`amsets-app/.env.local`)
```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_PROGRAM_ID=B2gRbiH...
NEXT_PUBLIC_WEB3AUTH_CLIENT_ID=...
NEXT_PUBLIC_MINT_AUTHORITY_PUBKEY=...
NEXT_PUBLIC_HELIUS_RPC_URL=...
```

---

## 13. How to Read On-Chain Data Without Backend

Any developer can read AMSETS data directly from Solana:

```typescript
// Get global stats
const [registryPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("registry")],
  new PublicKey("B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG")
);
const stats = await connection.getAccountInfo(registryPda);
// deserialize: 8 bytes discriminator, then 4×u64 (LE), then 1 byte bump

// Get content record
const [contentPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("content"), authorPubkey.toBuffer(), contentIdBytes],
  programId
);
const record = await connection.getAccountInfo(contentPda);
// Borsh layout documented in section 2
```

---

*This document is auto-maintained. Update it after any smart contract redeployment.*
