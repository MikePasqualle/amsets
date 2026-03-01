# AMSETS — Локальне розгортання (Dev / Devnet)

> Цей документ описує як запустити повний стек AMSETS локально для розробки та тестування.  
> Мережа: **Solana Devnet** · Відео: **Livepeer Studio** · БД: **PostgreSQL** · Кеш: **Redis**

---

## Що потрібно встановити заздалегідь

| Інструмент | Версія | Завантажити |
|---|---|---|
| Node.js | 20+ | https://nodejs.org |
| npm | 10+ | входить у Node.js |
| PostgreSQL | 15+ | https://www.postgresql.org/download |
| Redis | 7+ | https://redis.io/download |
| Rust | stable | https://rustup.rs |
| Solana CLI | 1.18+ | https://docs.solana.com/cli/install-solana-cli-tools |
| Anchor CLI | 0.30+ | `cargo install --git https://github.com/coral-xyz/anchor avm --locked` |
| Git | any | https://git-scm.com |

---

## Крок 1 — Клонування репозиторію

```bash
git clone https://github.com/MikePasqualle/amsets.git
cd amsets
git checkout dev
```

---

## Крок 2 — Налаштування PostgreSQL

```bash
# Запустити PostgreSQL (якщо ще не запущено)
# macOS (Homebrew)
brew services start postgresql@15

# Ubuntu / Debian
sudo systemctl start postgresql

# Створити базу даних і користувача
psql postgres -c "CREATE USER amsets WITH PASSWORD 'amsets';"
psql postgres -c "CREATE DATABASE amsets_db OWNER amsets;"
```

---

## Крок 3 — Налаштування Redis

```bash
# macOS
brew services start redis

# Ubuntu / Debian
sudo systemctl start redis
```

---

## Крок 4 — Налаштування змінних середовища (Backend)

```bash
cd amsets-api
cp .env.example .env
```

Відкрий файл `amsets-api/.env` і заповни:

```env
# Server
PORT=3001
NODE_ENV=development

# Database
DATABASE_URL=postgresql://amsets:amsets@localhost:5432/amsets_db

# Redis
REDIS_URL=redis://localhost:6379

# JWT (згенеруй випадковий рядок)
JWT_SECRET=згенеруй_тут_64_символи   # openssl rand -hex 64
JWT_EXPIRES_IN=7d

# Solana Devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
HELIUS_API_KEY=твій_helius_api_key       # https://dev.helius.xyz
PROGRAM_ID=B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG

# IPFS (Pinata)
PINATA_JWT=твій_pinata_jwt              # https://pinata.cloud → API Keys
PINATA_GATEWAY=https://gateway.pinata.cloud

# Livepeer
LIVEPEER_API_KEY=твій_livepeer_api_key  # https://livepeer.studio → API Keys

# Mint Authority (ключ бекенду для SPL токенів)
MINT_AUTHORITY_SECRET=base58_private_key

# Admin
ADMIN_SECRET=придумай_секретний_пароль
```

### Як отримати ключі

**Helius API Key:**
1. Зайди на https://dev.helius.xyz
2. Зареєструйся → Dashboard → Create API Key
3. Скопіюй ключ

**Pinata JWT:**
1. Зайди на https://pinata.cloud
2. Dashboard → API Keys → New Key → Admin → Generate
3. Скопіюй JWT

**Livepeer API Key:**
1. Зайди на https://livepeer.studio
2. Зареєструйся → Dashboard → Developers → API Keys → Create

**Mint Authority Keypair:**
```bash
# Генерує новий ключ для бекенду
solana-keygen new --outfile ~/amsets-mint-authority.json --no-bip39-passphrase
# Переведи у base58 рядок:
cat ~/amsets-mint-authority.json | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf-8');
const bs=require('bs58');
console.log(bs.encode(Buffer.from(JSON.parse(d))));
"
```

---

## Крок 5 — Налаштування змінних середовища (Frontend)

```bash
cd amsets-app
cp .env.local.example .env.local   # або створи файл вручну
```

Відкрий `amsets-app/.env.local`:

```env
# API
NEXT_PUBLIC_API_URL=http://localhost:3001

# Solana
NEXT_PUBLIC_SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=ТВІЙ_HELIUS_KEY
NEXT_PUBLIC_PROGRAM_ID=B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG

# Web3Auth (email/Google/Apple login)
NEXT_PUBLIC_WEB3AUTH_CLIENT_ID=твій_web3auth_client_id  # https://dashboard.web3auth.io

# Pinata IPFS
NEXT_PUBLIC_PINATA_JWT=твій_pinata_jwt
NEXT_PUBLIC_PINATA_GATEWAY=https://gateway.pinata.cloud

# Mint authority pubkey (публічний ключ від MINT_AUTHORITY_SECRET)
NEXT_PUBLIC_MINT_AUTHORITY_PUBKEY=публічний_ключ_mint_authority
```

**Web3Auth Client ID (для login по email):**
1. Зайди на https://dashboard.web3auth.io
2. Create Project → Web3Auth SDK: `Modal`
3. Network: `Sapphire Devnet`
4. Скопіюй Client ID

---

## Крок 6 — Встановлення залежностей

```bash
# Backend
cd amsets-api && npm install

# Frontend
cd ../amsets-app && npm install
```

---

## Крок 7 — Міграція бази даних

```bash
cd amsets-api
npm run db:push    # застосовує схему до PostgreSQL
```

Якщо команда не знайдена, запусти вручну:
```bash
npx drizzle-kit push
```

---

## Крок 8 — Налаштування Solana Devnet

```bash
# Переключися на devnet
solana config set --url devnet

# Перевір поточний гаманець
solana address

# Якщо гаманця немає — створи:
solana-keygen new --outfile ~/.config/solana/id.json

# Поповни гаманець тестовими SOL
solana airdrop 2
```

### Деплой смарт-контракту на Devnet

```bash
cd amsets-contracts

# Збери контракт
anchor build

# Задеплой на devnet
anchor deploy --provider.cluster devnet

# Перевір що деплой пройшов
solana program show B2gRbiHAfn7sZo8Kyecoc8xbkMzbgA7f7oJvBVjJxatG
```

> Якщо Program ID змінився після деплою — оновни `PROGRAM_ID` та `NEXT_PUBLIC_PROGRAM_ID` у `.env` файлах.

---

## Крок 9 — Запуск локально

Відкрий **два термінали**:

**Термінал 1 — Backend:**
```bash
cd amsets-api
npm run dev
# → http://localhost:3001
```

**Термінал 2 — Frontend:**
```bash
cd amsets-app
npm run dev
# → http://localhost:3000
```

---

## Крок 10 — Перевірка

Відкрий браузер та перейди на http://localhost:3000

Чек-лист:
- [ ] Головна сторінка відкривається
- [ ] Connect (Web3Auth — email) → отримую гаманець
- [ ] Connect (Phantom/Solflare) → підписую повідомлення
- [ ] Publish → завантажую відео → відео в статусі Active
- [ ] Marketplace → бачу опублікований контент
- [ ] Відкриваю контент → відео відтворюється
- [ ] Купую доступ (потрібен devnet SOL на гаманці)
- [ ] My Works → бачу своє опубліковане відео
- [ ] My Library → бачу куплений контент

---

## Зупинка

```bash
# Ctrl+C у кожному терміналі
# Або вбити процеси за портами:
lsof -ti:3001 | xargs kill -9
lsof -ti:3000 | xargs kill -9
```

---

## Часті проблеми

| Проблема | Причина | Рішення |
|---|---|---|
| `ECONNREFUSED 5432` | PostgreSQL не запущений | `brew services start postgresql@15` |
| `ECONNREFUSED 6379` | Redis не запущений | `brew services start redis` |
| `LIVEPEER_API_KEY is not set` | Не заповнений .env | Додай ключ у `amsets-api/.env` |
| Відео не відтворюється | Ще транскодується | Зачекай 1-2 хвилини після завантаження |
| `Failed to fetch` 401 | JWT прострочений | Відключи і знову підключи гаманець |
| Транзакція не проходить | Немає SOL на devnet | `solana airdrop 2` |
