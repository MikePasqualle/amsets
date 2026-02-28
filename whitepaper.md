# AMSETS Whitepaper

**Version 1.0 — February 2026**

---

## Abstract

AMSETS is a fully decentralized intellectual property rights ledger built on the Solana blockchain. It enables creators — filmmakers, musicians, educators, researchers, and other knowledge workers — to register original video works on-chain, set programmable access terms, and monetize their content directly, without intermediaries. Buyers receive non-fungible SPL Token-2022 access tokens that grant streaming access via Livepeer's decentralized video network. All core ownership data is stored immutably on Solana; previews and metadata live on IPFS; video content is streamed via Livepeer Studio with JWT-gated access control. The backend database is a cache only — the blockchain is the single source of truth.

AMSETS solves three critical problems that existing platforms fail to address together: (1) the absence of on-chain, tamper-proof copyright registration accessible to individuals; (2) the centralized control of content distribution and revenue flows; and (3) the lack of programmable, trustless royalty enforcement on secondary sales.

---

## 1. Problem Statement

### 1.1 The Centralization Problem

Today's content economy runs on centralized platforms that act as gatekeepers: they store content, determine discoverability, set fee structures, and can demonetize or remove works at will. A creator who uploads to a streaming platform or marketplace owns nothing more than a row in that platform's database. When the platform shuts down or changes terms, the creator's monetization evaporates.

### 1.2 The Copyright Registration Gap

Formal copyright registration is expensive, slow, jurisdiction-dependent, and practically inaccessible to independent creators globally. Informal "poor man's copyright" methods (emailing yourself a file, posting on social media) provide no enforceable proof. There is no universally accessible, tamper-proof, timestamped registry that any creator can write to in seconds for a fraction of a cent.

### 1.3 The Royalty Enforcement Gap

Even when creators license work digitally, royalty enforcement on secondary transfers is purely contractual — it relies on buyers honoring terms. There is no technical mechanism that automatically routes royalty payments to the creator when a content access token is resold on a secondary market.

### 1.4 The Access Control Problem

Existing DRM systems are centralized, proprietary, and hostile to user privacy. They require trusting a third party to maintain the encryption key management infrastructure. When that service is compromised or discontinued, content becomes either permanently inaccessible or permanently exposed.

---

## 2. Solution

AMSETS addresses all four problems with a four-layer decentralized architecture:

| Layer | Technology | What it stores |
|---|---|---|
| Layer 1 — Ownership | Solana (Anchor) | `ContentRecord` PDA: hash, price, license, access mint |
| Layer 2 — Access Keys | Lit Protocol | JWT-gated playback conditions tied to SPL token ownership |
| Layer 3 — Content | Livepeer Studio | Transcoded video streams with JWT access control |
| Layer 4 — Previews | IPFS via Pinata | Preview images and metadata JSON (fast CDN delivery) |

The backend API (Hono + PostgreSQL + Redis) is a **cache layer only** — it indexes and serves data from the chain but cannot alter ownership records, access conditions, or encrypted content.

---

## 3. Technical Architecture

### 3.1 Smart Contract — Solana / Anchor

The core registry is an Anchor program deployed on Solana. It manages the following on-chain state:

**Content Record** (Program Derived Account):
Each registered work gets a unique on-chain account that stores:
- SHA-256 fingerprint of the original file (tamper-proof proof of existence)
- Livepeer playback ID (`livepeer://...`) — canonical pointer to the video
- IPFS preview URI
- Creator wallet address
- SPL Token-2022 mint address (access token)
- Base price (lamports), payment method, license type
- Total supply and remaining supply for access tokens
- Royalty percentage for secondary sales
- Active status

**On-chain operations:**
- Content registration — Author creates a permanent on-chain record. Requires author signature.
- Access token minting — Issued to buyers after confirmed payment.
- Purchase — Buyer pays; funds split automatically (97.5% author, 2.5% protocol).
- Protocol vault — Accumulates protocol fees; managed by multisig governance.

The full program source code is open-source and verifiable on-chain. Security audits are planned before mainnet launch.

### 3.2 Token Standard — SPL Token-2022

Access tokens use the **SPL Token-2022** standard (Token Extensions Program). The `TransferFee` extension is configured at mint creation with `royalty_bps` as the fee, routing automatic royalty payments to the author's fee account on every secondary transfer. This makes royalty enforcement fully trustless and on-chain — no marketplace cooperation required.

Each content item has exactly **one SPL Token-2022 mint**. The author always holds one token (proof of authorship). Buyers receive one token each, up to `total_supply`. Token holders can list their token for sale on the AMSETS marketplace; the `TransferFee` extension ensures the author receives royalties on every resale automatically.

### 3.3 Access Control — Lit Protocol + Livepeer JWT

Video access is enforced through a two-layer mechanism:

1. **On-chain token check**: The backend verifies that the requesting wallet holds a valid SPL Token-2022 access token by querying the purchase records and Solana token accounts.
2. **Livepeer JWT**: Upon successful verification, the backend signs an ES256 JSON Web Token using the Livepeer Studio signing key. This JWT is passed to the Livepeer Player, which forwards it to the Livepeer CDN. The CDN refuses playback without a valid JWT.

Lit Protocol remains in the stack for future advanced key management (e.g., decentralized JWT signing conditions tied to on-chain SPL token balance). The current implementation uses backend-signed JWTs for reliability and speed.

### 3.4 Content Storage — Livepeer Studio

Video content is uploaded to **Livepeer Studio** — a decentralized video streaming network backed by distributed transcoding nodes. Each upload:

- Is processed via TUS resumable upload directly from the browser to Livepeer's CDN
- Receives a unique `playbackId` that is written into the on-chain `ContentRecord` as `livepeer://{playbackId}`
- Is transcoded automatically into adaptive bitrate streams (HLS) by the Livepeer network
- Is protected by JWT-based access control — only verified token holders can play the video

The `playbackId` on-chain is the canonical pointer to the content. Livepeer's open network of transcoding nodes ensures no single point of failure in video delivery.

**Content fingerprinting**: The SHA-256 hash of the original file is still computed client-side and stored on-chain in the `ContentRecord`, providing tamper-proof proof of existence at registration time.

### 3.5 Marketplace Indexing — Helius

The marketplace reads all on-chain content records from Solana using the Helius enhanced RPC API. Data is deserialized, enriched with cached metadata, and served with short TTL caching (Redis). Helius webhooks trigger cache invalidation on every new blockchain transaction, keeping the marketplace view near-real-time.

The AMSETS backend is a cache layer only. The blockchain is the authoritative source — the marketplace could be rebuilt from on-chain data alone without any backend.

### 3.6 Authentication

AMSETS supports two authentication paths:

1. **Web3Auth** (email / phone / Google / Apple) — creates a Solana MPC wallet silently for Web2 users. No seed phrase required. The wallet is fully controlled by the user via their social login credentials.
2. **Wallet Adapter** (Phantom, Solflare) — direct Solana wallet connection for Web3-native users.

In both cases, authentication to the backend API uses **Ed25519 signature verification**: the client signs a challenge message with their Solana private key; the backend verifies the signature and issues a short-lived JWT for session use.

---

## 4. Token Economics

### 4.1 Revenue Flow per Purchase

```
Buyer pays: P SOL
  → 97.5% (P × 0.975) → Author wallet
  →  2.5% (P × 0.025) → AMSETS FeeVault PDA
```

### 4.2 Royalties on Secondary Sales

When a buyer resells their access token, the SPL Token-2022 `TransferFee` extension automatically withholds `royalty_bps / 100`% (e.g., 10% if `royalty_bps = 1000`) and routes it to the author's designated fee account. AMSETS does not take a fee on secondary sales — 100% of royalties go directly to the original creator.

### 4.3 Protocol Fee

The 2.5% protocol fee accumulates in the `FeeVault` PDA on Solana. It funds:
- Infrastructure and RPC costs (Helius, IPFS pinning)
- Protocol development and audits
- Ecosystem grants for creators

### 4.4 Supply Model

Creators set `total_supply` at publication time (minimum 1, no maximum). The author always receives 1 token at no cost. The remaining `total_supply - 1` tokens are available for purchase. Once all tokens are sold, `available_supply` reaches 0 and further purchases are rejected by the smart contract — creating digital scarcity enforced on-chain.

---

## 5. Team

**Michael Patsan — Founder & CEO**
Entrepreneur and product strategist with experience building Web3 infrastructure products. Focused on bridging Web2 user experience with decentralized ownership models.

**Artem Atepalikhin — Founder**
Full-stack engineer with deep experience in distributed systems, cryptography, and blockchain protocols. Architected the AMSETS smart contract and decentralized storage pipeline.

---

## 6. Roadmap

### Phase 1 — MVP (Current)
- On-chain content registration (Solana Devnet → Mainnet)
- SPL Token-2022 access tokens with TransferFee royalties
- Livepeer Studio video upload and JWT-gated playback
- Lit Protocol access conditions for decentralized key management
- Web3Auth email/phone + Phantom/Solflare wallet support
- Marketplace with Helius indexing
- Token resale listings on the secondary market

### Phase 2 — Q3 2026
- Mobile app (React Native)
- Embeddable content widget (`amsets.xyz/embed/:id`)
- HTTP 402 paywall for AI agent access (machine-readable content licensing)
- USDC payment support
- Batch minting for music albums, book series
- Creator analytics dashboard

### Phase 3 — Q4 2026
- DAO governance for protocol fee parameters
- Cross-chain bridging (Ethereum → Solana content receipts)
- Creator API for programmatic content registration
- Enterprise licensing module (organization-level tokens)
- AMSETS SDK for third-party marketplace integration

### Phase 4 — 2027
- Decentralized dispute resolution for copyright conflicts
- AI-powered content fingerprinting for plagiarism detection
- Physical-digital twin registration (merchandise, prints)
- Mainnet full launch with audited contracts

---

## 7. Security

- **Smart contract**: All on-chain instructions are permissioned by cryptographic signatures. Ownership transfers and fund movements require valid signer authorization. The program is open-source and pending a third-party security audit before mainnet launch.
- **Access control**: Video playback requires a backend-signed JWT tied to on-chain token ownership. Without a valid JWT, Livepeer CDN refuses delivery. JWTs expire after 1 hour and must be re-requested.
- **Decentralized key management**: Lit Protocol is integrated in the stack for future threshold-cryptography access conditions. Access conditions will be enforced by verifying on-chain token ownership across a distributed node network.
- **Content fingerprinting**: SHA-256 hash of every uploaded file is computed client-side and stored immutably on Solana, providing tamper-proof proof of existence at the time of registration.
- **No custodial control**: The AMSETS backend holds no private keys, no decryption keys, and cannot alter ownership records. Only the content owner, acting with their private key, can modify on-chain state.
- **Responsible disclosure**: Security vulnerabilities can be reported to security@amsets.xyz. A bug bounty program will be announced alongside the mainnet launch.

---

## 8. Legal Disclaimer

AMSETS provides a technical infrastructure for on-chain content registration. It does not constitute legal copyright registration in any jurisdiction. AMSETS does not verify the originality of registered content and assumes no liability for copyright disputes between users. Users are solely responsible for ensuring they have the rights to register and monetize uploaded content. Access tokens are utility tokens representing a license to access specific digital content; they do not represent securities or investment instruments. This whitepaper is for informational purposes only and does not constitute financial, legal, or investment advice.

---

*© 2026 AMSETS. All rights reserved.*
