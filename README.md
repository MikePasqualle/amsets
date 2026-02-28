# AMSETS — Decentralized IP Rights Ledger

> Register, protect and monetize your intellectual property on Solana.

## Architecture

```
amsets-contracts/   → Anchor (Rust) — on-chain registry
amsets-api/         → Hono (Node.js/TypeScript) — REST backend
amsets-app/         → Next.js 14 — frontend
docker-compose.yml  → PostgreSQL 16 + Redis 7 (local dev)
```

## Quick Start

### Prerequisites
- Node.js 18+
- Rust + Cargo
- Anchor CLI 0.29.0 (`cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked`)
- Solana CLI 1.17+ (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- Docker Desktop

### 1. Infrastructure

```bash
docker compose up -d
```

### 2. Backend

```bash
cd amsets-api
cp .env.example .env
# Fill in your keys in .env
npm install
npm run db:generate && npm run db:migrate
npm run dev
# → http://localhost:3001
```

### 3. Frontend

```bash
cd amsets-app
cp .env.local.example .env.local
# Fill in your keys in .env.local
npm install
npm run dev
# → http://localhost:3000
```

### 4. Smart Contract (Devnet)

```bash
cd amsets-contracts
anchor build
anchor deploy --provider.cluster devnet
# Copy the deployed program ID to Anchor.toml and lib.rs
anchor test --provider.cluster devnet
```

## External Services Setup

| Service | Where to Register | What to Get |
|---|---|---|
| Helius | helius.dev | API key for Solana RPC + DAS |
| Web3Auth | dashboard.web3auth.io | Client ID |
| Pinata | pinata.cloud | JWT for IPFS uploads |
| Lit Protocol | developer.litprotocol.com | Network config |

## Key User Flows

### Creator Upload Flow
1. Connect wallet (Web3Auth email/phone or Phantom)
2. Upload file → auto-encrypted AES-256-GCM in browser
3. File uploaded to Arweave (permanent, encrypted)
4. Key encrypted by Lit Protocol with NFT access condition
5. Anchor smart contract registers IP + mints ownership NFT
6. Share `amsets.xyz/c/{content_id}` link

### Buyer Purchase Flow
1. Browse marketplace, click content
2. Pay SOL (97.5% to author, 2.5% protocol fee)
3. Receive access NFT in wallet
4. Click "View" → Lit Protocol verifies NFT → decrypts key
5. File decrypted in-browser, displayed securely

## License
MIT
