# AMSETS — Technical Specifications

## Tech Stack (Implemented)

| Layer | Technology | Version | Status |
|---|---|---|---|
| **Smart Contract** | Anchor (Rust) | 0.32.0 | ✅ Built + Token System |
| **Blockchain** | Solana | Devnet → Mainnet | ✅ Configured |
| **Backend** | Hono (Node.js/TypeScript) | Latest | ✅ Built |
| **Frontend** | Next.js 14 App Router | 15.x | ✅ Built |
| **Database** | PostgreSQL 16 + Drizzle ORM | — | ✅ Schema |
| **Cache** | Redis 7 | — | ✅ Built |
| **Auth** | Web3Auth v9 + Wallet Adapter | — | ✅ Built |
| **Encryption** | AES-256-GCM (browser) | Web Crypto API | ✅ Built |
| **Key Management** | Lit Protocol | datil-dev/datil | ✅ Built |
| **Token Standard** | SPL Token-2022 (TransferFee) | — | ✅ Implemented |
| **Resale Market** | Listings (PostgreSQL + on-chain transfer) | — | ✅ Implemented |
| **Permanent Storage** | Arweave via Irys | — | ✅ Client SDK |
| **Preview Storage** | IPFS via Pinata | — | ✅ Built |
| **Animations** | GSAP + @gsap/react + Lenis | v3.12 / v1.x | ✅ Built |
| **Styling** | Tailwind CSS v4 | 4.2.0 | ✅ Configured |

## Project Structure

```
amsets/
├── amsets-contracts/          # Anchor (Rust) smart contract
│   ├── programs/
│   │   └── amsets-registry/
│   │       └── src/lib.rs     # ContentRecord, register_content, purchase_access_sol
│   ├── tests/
│   │   └── amsets-registry.ts # Mocha tests (3 test cases)
│   └── Anchor.toml
│
├── amsets-api/                # Hono backend
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema.ts      # Drizzle ORM schema (users, content, purchases)
│   │   │   ├── index.ts       # PostgreSQL pool
│   │   │   └── redis.ts       # Redis client + helpers
│   │   ├── routes/
│   │   │   ├── auth.route.ts
│   │   │   ├── marketplace.route.ts
│   │   │   └── content.route.ts
│   │   ├── services/
│   │   │   ├── jwt.service.ts
│   │   │   ├── solana.service.ts
│   │   │   └── storage.service.ts
│   │   └── index.ts
│   ├── drizzle.config.ts
│   └── docker-compose.yml
│
└── amsets-app/                # Next.js 14 frontend
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx            # Marketplace (SSR)
    │   ├── c/[contentId]/
    │   ├── upload/
    │   ├── my/library/
    │   └── my/content/
    ├── components/
    │   ├── layout/             # Navbar, Footer, PageTransition
    │   ├── animations/         # useLogoReveal, useScrollReveal, useHoverGlow, useDragZone
    │   ├── auth/               # AuthModal
    │   ├── content/            # ContentCard, ContentGrid, ContentViewer, DragZone, UploadSteps
    │   └── ui/                 # GlowButton, NeonBadge, ConfettiCanvas
    ├── lib/
    │   ├── crypto.ts           # AES-256-GCM
    │   ├── lit.ts              # Lit Protocol wrapper
    │   ├── storage.ts          # Irys + Pinata
    │   └── useAuth.ts          # Auth hook (Web3Auth + Wallet Adapter)
    ├── providers/
    │   ├── SmoothScrollProvider.tsx  # Lenis + GSAP ticker
    │   ├── WalletProvider.tsx
    │   └── Providers.tsx
    └── public/brand/           # logo-light.svg, logo-dark.svg
```

## Smart Contract — amsets-registry

### Program ID
`AMSETSrgstRY1111111111111111111111111111111` (placeholder — replace after `anchor deploy`)

### Instructions

| Instruction | Description |
|---|---|
| `register_content` | Creates ContentRecord PDA, mints 1 ownership NFT to author |
| `purchase_access_sol` | Buyer pays SOL → 97.5% author + 2.5% fee vault, mints access NFT |

### ContentRecord PDA
Seeds: `[b"content", author.pubkey(), content_id]`

Fields: `content_id`, `content_hash`, `storage_uri`, `preview_uri`, `primary_author`, `access_mint`, `base_price`, `payment_token`, `license`, `is_active`, `bump`

## Backend API

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/v1/auth/verify` | POST | — | Ed25519 verify, issue JWT |
| `/api/v1/auth/content-access` | POST | JWT | Verify NFT ownership, issue content JWT |
| `/api/v1/marketplace` | GET | — | Paginated content list (Redis cached) |
| `/api/v1/content/:id` | GET | — | Public content metadata |
| `/api/v1/content/register` | POST | JWT | Register IP, get Anchor params |
| `/api/v1/content/:id/confirm` | POST | JWT | Confirm on-chain tx |
| `/api/v1/content/:id/lit-data` | GET | Content JWT | Lit Protocol key data |

## Authentication Flow

### Path A: Email/Phone/Google (Web3Auth MPC)
1. User clicks email/phone/Google in AuthModal
2. Web3Auth modal opens → user authenticates
3. Web3Auth derives Solana keypair via MPC threshold cryptography
4. Wallet-adapter receives the keypair
5. Frontend signs auth message → POST /api/v1/auth/verify → JWT

### Path B: Existing Wallet (Phantom/Solflare)
1. User clicks "Connect Phantom/Solflare" → Wallet Adapter modal
2. User approves connection in wallet extension
3. Frontend signs auth message → POST /api/v1/auth/verify → JWT

## Encryption Flow

### Upload
1. `generateSymmetricKey()` → AES-256-GCM key
2. `computeSHA256(file)` → content_hash (on-chain proof)
3. `encryptFile(key, file)` → { ciphertext, iv }
4. `packEncrypted(iv, ciphertext)` → packed buffer
5. `uploadToArweave(packed)` → `ar://{txId}`
6. `encryptKeyForContent(key, accessMint)` → via Lit Protocol
7. POST `/api/v1/content/register` with all data

### View (Post-purchase)
1. Backend verifies NFT ownership (Helius DAS)
2. Backend issues `content_jwt`
3. Frontend calls GET `/api/v1/content/:id/lit-data`
4. `decryptKeyForContent(encryptedKey, hash, authSig, accessMint)` → AES key
5. `downloadFromArweave(ar://txId)` → packed buffer
6. `unpackEncrypted(packed)` → { iv, ciphertext }
7. `decryptFile(key, iv, ciphertext)` → original file
8. Render in-memory: `blob:` URL for video, Canvas for PDF

## Brand Design System

| Token | Value | Usage |
|---|---|---|
| `--color-bg` | `#0D0A14` | Main background |
| `--color-surface` | `#221533` | Cards, modals |
| `--color-primary` | `#F7FF88` | CTAs, logo AMSETS |
| `--color-secondary` | `#81D0B5` | Links, badges, "space" |
| `--color-text` | `#EDE8F5` | Body text |
| `--color-muted` | `#7A6E8E` | Secondary text |
| `--color-border` | `#3D2F5A` | Borders |

## Local Development

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Database migration
cd amsets-api
npm run db:generate
npm run db:migrate

# 3. Run backend
npm run dev

# 4. Run frontend
cd amsets-app
npm run dev

# 5. Contract (local validator)
solana-test-validator &
cd amsets-contracts
anchor build
anchor deploy
anchor test
```
