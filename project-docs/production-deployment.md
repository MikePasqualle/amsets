# AMSETS — Production Deployment Plan

> **Target**: Solana Mainnet-Beta + production cloud infrastructure  
> **Stack**: Next.js (Vercel) · Hono API (Railway/Fly.io) · PostgreSQL · Redis · Anchor smart contract

---

## 1. Pre-Deployment Checklist

### 1.1 Smart Contract Audit
- [ ] Complete third-party security audit (Sec3, OtterSec, or Neodyme)
- [ ] Resolve all critical/high findings before mainnet deploy
- [ ] Set upgrade authority to **3-of-5 multisig** (Squads Protocol)
- [ ] Prepare freeze/pause mechanism for emergency response

### 1.2 Environment Secrets
All secrets must be rotated from devnet values before mainnet:

| Secret | Where to get | Where to set |
|--------|-------------|--------------|
| `DEPLOYER_KEYPAIR` | New dedicated deployer wallet | Never in code; use CI secret |
| `JWT_SECRET` | `openssl rand -hex 64` | Backend env |
| `HELIUS_API_KEY` | helius.dev (production tier) | Backend + Frontend env |
| `PINATA_JWT` | pinata.cloud (paid plan) | Frontend env |
| `WEB3AUTH_CLIENT_ID` | dashboard.web3auth.io (mainnet verifier) | Frontend env |
| `DATABASE_URL` | Managed PostgreSQL (Neon/Supabase/RDS) | Backend env |
| `REDIS_URL` | Managed Redis (Upstash) | Backend env |

### 1.3 New Web3Auth Verifier for Mainnet
- Log in to https://dashboard.web3auth.io
- Create a **new verifier** (Sapphire Mainnet, not Devnet)
- Update `NEXT_PUBLIC_WEB3AUTH_CLIENT_ID` with the mainnet client ID
- Change `web3AuthNetwork: "sapphire_mainnet"` in `useAuth.ts`

---

## 2. Smart Contract Deployment (Mainnet)

### 2.1 Prerequisites
```bash
# Switch CLI to mainnet
solana config set --url https://api.mainnet-beta.solana.com

# Fund the deployer wallet (need ~5 SOL for deployment rent)
# Transfer SOL manually to the deployer wallet address
solana balance <deployer-address>
```

### 2.2 Build & Deploy
```bash
cd amsets-contracts

# Build with optimized sbpf target
cargo build-sbf --manifest-path programs/amsets-registry/Cargo.toml

# Deploy to mainnet (keep program keypair OFFLINE and SECRET)
solana program deploy \
  target/sbpf-solana-solana/release/amsets_registry.so \
  --program-id deploy/amsets-registry-keypair.json \
  --keypair ~/.config/solana/deployer.json \
  --url https://api.mainnet-beta.solana.com

# Record the deployed program ID
echo "PROGRAM_ID=$(solana address -k deploy/amsets-registry-keypair.json)"
```

### 2.3 Post-Deploy: Initialize Fee Vault
```bash
# Run the initialization script (one-time only)
cd amsets-contracts
node scripts/initialize-vault.js --url https://api.mainnet-beta.solana.com
```

### 2.4 Transfer Upgrade Authority to Multisig
```bash
# Replace <MULTISIG_ADDRESS> with Squads multisig address
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <MULTISIG_ADDRESS> \
  --keypair ~/.config/solana/deployer.json
```

### 2.5 Update Program ID in Code
After deployment, update:
- `amsets-app/.env.local` → `NEXT_PUBLIC_PROGRAM_ID=<new-id>`
- `amsets-api/.env` → `PROGRAM_ID=<new-id>`
- `amsets-contracts/Anchor.toml` → `[programs.mainnet]`

---

## 3. Backend API Deployment

### 3.1 Recommended Platform: Railway
1. Go to https://railway.app → New Project → Deploy from GitHub
2. Select the `amsets-api` root directory
3. Set **Start Command**: `npm start`
4. Set all environment variables (see section 1.2)

**Production `.env` values to change:**
```env
NODE_ENV=production
PORT=3001
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<KEY>
PROGRAM_ID=<mainnet-program-id>
```

### 3.2 PostgreSQL (Neon recommended)
```bash
# Create managed PostgreSQL on neon.tech
# Copy the connection string to DATABASE_URL

# Run migrations on first deploy
cd amsets-api
npx drizzle-kit push
```

### 3.3 Redis (Upstash recommended)
- Create a database at https://upstash.com
- Copy `REDIS_URL` (TLS-enabled connection string)

### 3.4 Custom Domain
- Point `api.amsets.xyz` → Railway deployment via CNAME
- Enable HTTPS (automatic on Railway)

---

## 4. Frontend Deployment

### 4.1 Vercel (recommended)
```bash
# Install Vercel CLI
npm i -g vercel

cd amsets-app
vercel --prod
```

Or connect GitHub repo at https://vercel.com/new:
- Root directory: `amsets-app`
- Framework: Next.js
- Build command: `npm run build`
- Output: `.next`

### 4.2 Environment Variables on Vercel
Set all `NEXT_PUBLIC_*` variables in Vercel dashboard → Settings → Environment Variables:

```
NEXT_PUBLIC_API_URL=https://api.amsets.xyz
NEXT_PUBLIC_SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<KEY>
NEXT_PUBLIC_PROGRAM_ID=<mainnet-program-id>
NEXT_PUBLIC_WEB3AUTH_CLIENT_ID=<mainnet-client-id>
NEXT_PUBLIC_PINATA_JWT=<jwt>
NEXT_PUBLIC_PINATA_GATEWAY=https://amsets.mypinata.cloud
NEXT_PUBLIC_IRYS_NETWORK=mainnet
```

### 4.3 Lit Protocol: Switch to Mainnet
In `amsets-app/lib/lit.ts`, change:
```typescript
// dev:
litNodeClient = new LitNodeClient({ litNetwork: "datil-dev" });
// production:
litNodeClient = new LitNodeClient({ litNetwork: "datil" });
```

### 4.4 Domain
- Point `amsets.xyz` and `www.amsets.xyz` → Vercel via DNS CNAME/A records
- Enable HTTPS (automatic on Vercel)

---

## 5. Helius Webhook (Production)

Register a webhook in Helius dashboard to keep the marketplace cache fresh:

- **Account addresses**: `[<PROGRAM_ID>]`
- **Transaction types**: `["TRANSACTION"]`
- **Webhook URL**: `https://api.amsets.xyz/api/v1/webhook/helius`
- **Auth header**: set `HELIUS_WEBHOOK_SECRET` in backend env

---

## 6. Pinata Production Setup

1. Go to https://app.pinata.cloud
2. Create a dedicated gateway: `amsets.mypinata.cloud`
3. Generate a new API key with `pinFileToIPFS` permission
4. Set `NEXT_PUBLIC_PINATA_JWT` in Vercel env
5. Enable "Content Addressable" gateway for public preview access

---

## 7. Monitoring & Alerting

| Tool | Purpose | Setup |
|------|---------|-------|
| Helius webhooks | Real-time on-chain events | Section 5 above |
| Railway metrics | CPU/RAM/error rate | Built-in to Railway dashboard |
| Vercel Analytics | Frontend performance | Enable in Vercel dashboard |
| UptimeRobot | Uptime monitoring | Monitor `api.amsets.xyz/api/v1/marketplace` |
| Sentry | Error tracking | `npm i @sentry/nextjs @sentry/node` → configure DSN |

---

## 8. Security Hardening (Production)

### 8.1 Backend
```bash
# Rate limiting — add to Hono middleware
import { rateLimiter } from "hono-rate-limiter";
app.use("/api/v1/auth/*", rateLimiter({ windowMs: 60_000, limit: 10 }));

# CORS — restrict to production domain only
app.use("/*", cors({ origin: "https://amsets.xyz" }));
```

### 8.2 JWT Rotation
- Set JWT expiry to 24h: `expiresIn: "24h"`
- Implement refresh token flow before launch

### 8.3 Database
- Enable SSL connections for PostgreSQL
- Restrict DB access to API server IP only (Neon/Supabase firewall rules)
- Daily automated backups

### 8.4 Program Keypair Security
- Store program keypair in hardware wallet (Ledger) or HSM
- After multisig transfer (section 2.4), the keypair should be taken offline
- **Never commit the keypair to Git**

---

## 9. Launch Sequence

```
Day -7:  Security audit complete → all critical findings resolved
Day -5:  Deploy to mainnet devnet-fork for final testing
Day -3:  Deploy smart contract to mainnet → initialize fee vault
Day -2:  Deploy backend API to Railway (production env)
Day -2:  Deploy frontend to Vercel (production env)
Day -1:  DNS cutover → amsets.xyz → Vercel, api.amsets.xyz → Railway
Day  0:  Enable Helius webhook → verify marketplace populates
Day  0:  Announce launch (Twitter/Discord)
Day +1:  Monitor error rates, RPC costs, Pinata usage
```

---

## 10. Cost Estimates (Monthly)

| Service | Tier | Estimated Cost |
|---------|------|---------------|
| Vercel | Pro | $20/mo |
| Railway (API) | Hobby+ | $5–20/mo |
| Neon (PostgreSQL) | Launch | $19/mo |
| Upstash (Redis) | Pay-as-you-go | $0–10/mo |
| Helius | Developer | $49/mo (or pay-per-RPC) |
| Pinata | Picante | $20/mo |
| Domain (amsets.xyz) | Annual | ~$12/yr |
| **Total** | | **~$115–140/mo** |

Solana mainnet transaction costs (at current fees): ~$0.000025 per registration (effectively free for users if sponsored).

---

*Last updated: February 2026*
