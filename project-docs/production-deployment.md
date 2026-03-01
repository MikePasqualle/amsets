# AMSETS — Розгортання на Продакшн (Mainnet)

> **Повний покроковий гайд для новачків**  
> Мережа: **Solana Mainnet-Beta** · Хостинг: **Vercel + Railway** · БД: **Neon** · Кеш: **Upstash**

---

## Загальна архітектура продакшн

```
Користувач
    ↓
Vercel (Frontend — Next.js)           ← amsets-app
    ↓
Railway (Backend API — Hono/Node.js)  ← amsets-api
    ↓
Neon (PostgreSQL)                     ← база даних
Upstash (Redis)                       ← кеш
    ↓
Livepeer Studio                       ← відео хостинг
Pinata / IPFS                         ← превью та метадані
Solana Mainnet-Beta                   ← блокчейн
```

---

## Підготовка: що потрібно перед початком

### Сервіси які потрібно зареєструвати (всі безкоштовно на старті)

| Сервіс | Для чого | Посилання |
|---|---|---|
| GitHub | Зберігання коду | https://github.com |
| Vercel | Хостинг фронтенду | https://vercel.com |
| Railway | Хостинг бекенду | https://railway.app |
| Neon | PostgreSQL хмарна БД | https://neon.tech |
| Upstash | Redis хмарний кеш | https://upstash.com |
| Helius | Solana RPC + індексатор | https://helius.xyz |
| Livepeer Studio | Відео хостинг | https://livepeer.studio |
| Pinata | IPFS зберігання | https://pinata.cloud |
| Web3Auth | Login по email/соцмережах | https://dashboard.web3auth.io |

### Гаманці які потрібно створити

Тобі знадобляться **два окремих гаманці**:

1. **Deployer Wallet** — для деплою смарт-контракту на mainnet (потрібно ~3 SOL)
2. **Mint Authority Wallet** — бекенд-гаманець що підписує SPL токени (потрібно ~0.5 SOL)

> ⚠️ **Ніколи не використовуй один і той самий гаманець для двох ролей!**  
> ⚠️ **Зберігай seed phrases у безпечному місці — вони не відновлюються!**

---

## Частина 1 — Підготовка ключів та сервісів

### 1.1 Встановлення Solana CLI (якщо ще немає)

```bash
# macOS / Linux
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Перезапусти термінал, потім перевір:
solana --version
```

### 1.2 Створення Deployer Wallet

```bash
# Генерує новий гаманець
solana-keygen new --outfile ~/amsets-deployer.json --no-bip39-passphrase

# Покаже публічний ключ (адресу гаманця)
solana-keygen pubkey ~/amsets-deployer.json
```

Запиши публічний ключ — він знадобиться для поповнення SOL.

Поповни цей гаманець **щонайменше 3 SOL** на mainnet через будь-яку біржу (Binance, Coinbase, OKX) або через Phantom.

### 1.3 Створення Mint Authority Wallet

```bash
solana-keygen new --outfile ~/amsets-mint-authority.json --no-bip39-passphrase
solana-keygen pubkey ~/amsets-mint-authority.json
```

Поповни цей гаманець **0.5 SOL** — він витрачається при мінтингу кожного токена (~0.002 SOL за токен).

### 1.4 Конвертація Mint Authority ключа у base58 рядок

```bash
# Встанови Node.js якщо немає
node -e "
const fs = require('fs');
const bytes = JSON.parse(fs.readFileSync(process.env.HOME + '/amsets-mint-authority.json', 'utf-8'));
const base58chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
let result = '';
while (n > 0n) { result = base58chars[Number(n % 58n)] + result; n = n / 58n; }
console.log('MINT_AUTHORITY_SECRET=' + result);
"
```

Збережи цей рядок — він піде у `MINT_AUTHORITY_SECRET` у налаштуваннях Railway.

---

## Частина 2 — Деплой смарт-контракту на Mainnet

### 2.1 Встановлення Anchor

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install latest
avm use latest
anchor --version
```

### 2.2 Переключення на Mainnet

```bash
solana config set --url mainnet-beta
solana config set --keypair ~/amsets-deployer.json
solana balance  # перевір що є SOL
```

### 2.3 Клонування та збірка контракту

```bash
git clone https://github.com/MikePasqualle/amsets.git
cd amsets/amsets-contracts

# Встановити залежності та зібрати
anchor build
```

### 2.4 Деплой на Mainnet-Beta

```bash
anchor deploy --provider.cluster mainnet-beta --provider.wallet ~/amsets-deployer.json
```

Після успішного деплою в терміналі з'явиться:
```
Program Id: НОВИЙ_PROGRAM_ID
Deploy success
```

**Запиши цей Program ID** — він потрібен для всіх конфігів!

### 2.5 Ініціалізація Fee Vault

```bash
# Після деплою потрібно ініціалізувати платіжне сховище
# Це робиться один раз через адмін-сторінку після запуску фронту
# або через Anchor CLI:
anchor run initialize-vault --provider.cluster mainnet-beta
```

---

## Частина 3 — База даних (Neon)

### 3.1 Реєстрація та створення БД

1. Зайди на https://neon.tech
2. Натисни **Sign Up** → зареєструйся через GitHub
3. Натисни **Create Project**
4. Вкажи:
   - Project name: `amsets-prod`
   - Region: вибери найближчий до твоїх користувачів (EU Frankfurt або US East)
   - PostgreSQL version: `15`
5. Натисни **Create Project**

### 3.2 Отримання рядка підключення

1. На сторінці проекту знайди розділ **Connection Details**
2. Вибери **Connection string** → скопіюй рядок виду:
   ```
   postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```
3. Збережи — це твій `DATABASE_URL`

---

## Частина 4 — Redis (Upstash)

### 4.1 Реєстрація та створення Redis

1. Зайди на https://upstash.com
2. **Sign Up** → зареєструйся через GitHub
3. Натисни **Create Database**
4. Вкажи:
   - Name: `amsets-prod`
   - Region: той самий що і Neon
   - Type: `Regional`
5. Натисни **Create**

### 4.2 Отримання URL

1. Відкрий щойно створену БД
2. Знайди **REST URL** або **Redis URL** → скопіюй рядок виду:
   ```
   rediss://default:password@xxx.upstash.io:6379
   ```
3. Збережи — це твій `REDIS_URL`

---

## Частина 5 — Зовнішні сервіси

### 5.1 Helius (Solana RPC)

1. Зайди на https://helius.xyz → **Get API Key**
2. Зареєструйся → Dashboard → **Create API Key**
3. Скопіюй API Key
4. Твій RPC URL для mainnet: `https://mainnet.helius-rpc.com/?api-key=ТВІЙ_КЛЮЧ`

### 5.2 Livepeer Studio (відео)

1. Зайди на https://livepeer.studio → **Sign Up**
2. Dashboard → **Developers** → **API Keys** → **Create API Key**
3. Скопіюй API Key → це `LIVEPEER_API_KEY`

### 5.3 Pinata (IPFS для превью)

1. Зайди на https://pinata.cloud → **Sign Up**
2. Dashboard → **API Keys** → **New Key**
3. Дай назву: `amsets-prod`, вибери **Admin**
4. Натисни **Generate Key** → скопіюй **JWT** (довгий рядок)
5. Це `PINATA_JWT`
6. Також скопіюй **Gateway URL** (вигляд: `https://твій-id.mypinata.cloud`)

### 5.4 Web3Auth (email/Google login)

1. Зайди на https://dashboard.web3auth.io
2. **Sign In** → **Create Project**
3. Вибери:
   - Product: **Plug and Play**
   - Platform: **Web**
   - SDK: **Web3Auth Modal**
4. Скопіюй **Client ID**

**Важливо**: Для mainnet потрібно окремий верифікатор:
1. У проекті знайди **Verifiers** → **Create Verifier**
2. Додай домен свого сайту у **Whitelist URLs**
3. Змінних у `useAuth.ts`:
   ```typescript
   web3AuthNetwork: "sapphire_mainnet"  // замість "sapphire_devnet"
   ```

---

## Частина 6 — Деплой Backend (Railway)

### 6.1 Реєстрація та підключення репо

1. Зайди на https://railway.app → **Login** → через GitHub
2. Натисни **New Project** → **Deploy from GitHub repo**
3. Вибери репозиторій `amsets`
4. Railway запропонує вибрати папку — вибери `amsets-api`

### 6.2 Налаштування змінних середовища

У Railway відкрий свій сервіс → вкладка **Variables** → додай всі змінні:

```env
NODE_ENV=production
PORT=3001

DATABASE_URL=postgresql://...  (з Neon)
REDIS_URL=rediss://...          (з Upstash)

JWT_SECRET=згенеруй_64_символи  # openssl rand -hex 64
JWT_EXPIRES_IN=7d

SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=ТВІЙ_HELIUS_KEY
HELIUS_API_KEY=ТВІЙ_HELIUS_KEY
PROGRAM_ID=ТВІЙ_PROGRAM_ID_З_ДЕПЛОЮ_КОНТРАКТУ

PINATA_JWT=ТВІЙ_PINATA_JWT
PINATA_GATEWAY=https://ТВІЙ_ПІННЕР.mypinata.cloud

LIVEPEER_API_KEY=ТВІЙ_LIVEPEER_KEY

MINT_AUTHORITY_SECRET=BASE58_РЯДОК_З_КРОКУ_1.4

ADMIN_SECRET=ПРИДУМАЙ_СКЛАДНИЙ_ПАРОЛЬ
```

> Щоб згенерувати JWT_SECRET відкрий термінал і виконай:  
> `openssl rand -hex 64`

### 6.3 Налаштування команд запуску

У Railway → **Settings** → **Build & Deploy**:
- **Root Directory**: `amsets-api`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`

### 6.4 Міграція БД

Після першого деплою потрібно застосувати схему до Neon:

1. У Railway відкрий **Shell** (або **Run Command**)
2. Виконай:
   ```bash
   npm run db:push
   ```

### 6.5 Отримання URL бекенду

Після деплою Railway покаже URL виду:
```
https://amsets-api-production.up.railway.app
```
Збережи — це твій `NEXT_PUBLIC_API_URL`.

---

## Частина 7 — Деплой Frontend (Vercel)

### 7.1 Реєстрація та підключення репо

1. Зайди на https://vercel.com → **Sign Up** → через GitHub
2. **Add New Project** → вибери репозиторій `amsets`
3. Vercel запитає Root Directory → вкажи `amsets-app`
4. **Framework Preset**: Next.js (визначиться автоматично)

### 7.2 Налаштування змінних середовища

До натискання Deploy — натисни **Environment Variables** і додай:

```env
NEXT_PUBLIC_API_URL=https://amsets-api-production.up.railway.app

NEXT_PUBLIC_SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=ТВІЙ_HELIUS_KEY
NEXT_PUBLIC_PROGRAM_ID=ТВІЙ_PROGRAM_ID

NEXT_PUBLIC_WEB3AUTH_CLIENT_ID=ТВІЙ_WEB3AUTH_CLIENT_ID

NEXT_PUBLIC_PINATA_JWT=ТВІЙ_PINATA_JWT
NEXT_PUBLIC_PINATA_GATEWAY=https://ТВІЙ_ПІННЕР.mypinata.cloud

NEXT_PUBLIC_MINT_AUTHORITY_PUBKEY=ПУБЛІЧНИЙ_КЛЮЧ_MINT_AUTHORITY
```

### 7.3 Деплой

1. Натисни **Deploy**
2. Vercel збере і задеплоїть — займе 2-3 хвилини
3. Після завершення отримаєш URL виду: `https://amsets.vercel.app`

### 7.4 Налаштування власного домену (опційно)

1. У Vercel → твій проект → **Domains** → **Add Domain**
2. Введи свій домен (наприклад `amsets.space`)
3. Vercel покаже DNS записи які потрібно додати у твого реєстратора
4. Додай їх і зачекай 5-30 хвилин

---

## Частина 8 — Оновлення коду та повторний деплой

### Оновлення коду

```bash
git add .
git commit -m "опис змін"
git push origin main
```

**Vercel і Railway деплоять автоматично** при кожному push в `main` гілку.

---

## Частина 9 — Фінальна перевірка після деплою

Пройди по чек-листу після деплою:

- [ ] Сайт відкривається за продакшн URL
- [ ] Login через Web3Auth (email) працює
- [ ] Login через Phantom/Solflare працює
- [ ] Завантаження відео проходить успішно
- [ ] Відео з'являється на Marketplace
- [ ] Відео відтворюється після купівлі
- [ ] Транзакція проходить на Mainnet
- [ ] Платформа отримує комісію
- [ ] `/health` endpoint бекенду повертає `{ status: "ok" }`

---

## Частина 10 — Моніторинг та підтримка

### Логи

- **Frontend (Vercel)**: Dashboard → твій проект → **Functions** → **View Logs**
- **Backend (Railway)**: твій сервіс → вкладка **Logs**

### Сповіщення про помилки

Рекомендується підключити [Sentry](https://sentry.io) для відстеження помилок:

```bash
# У amsets-api та amsets-app
npm install @sentry/nextjs @sentry/node
```

### Бекап бази даних

Neon робить автоматичні бекапи. Додатково:
- Dashboard → **Branches** → **Create Branch** — створи точку відновлення перед кожним великим оновленням

---

## Розрахунок вартості (приблизно, per місяць)

| Сервіс | Безкоштовний план | Платний (при зростанні) |
|---|---|---|
| Vercel | $0 (до 100GB bandwidth) | $20/міс |
| Railway | $5/міс (starter) | $20+/міс |
| Neon | $0 (до 0.5 GB storage) | $19/міс |
| Upstash | $0 (до 10K команд/день) | $10/міс |
| Helius | $0 (до 100K запитів/міс) | $49/міс |
| Livepeer | $0 (до 1000 хв/міс) | залежить від трафіку |
| Pinata | $0 (до 1 GB) | $20/міс |
| **Всього** | **~$5/міс** | **$100-200/міс** |

---

## Безпека — обов'язкові заходи

1. **Ніколи** не комітти `.env` файли у git (перевір `.gitignore`)
2. **Ротуй** JWT_SECRET та ADMIN_SECRET кожні 90 днів
3. **Зберігай** seed phrases гаманців у KeePass або 1Password, НІКОЛИ у хмарі
4. **Заблокуй** адмін-роути за IP або Basic Auth у продакшн
5. **Увімкни** 2FA на всіх сервісах (Vercel, Railway, GitHub)
6. **Обмеж** CORS у `amsets-api/src/middleware/cors.middleware.ts` тільки своїм доменом:
   ```typescript
   origin: ["https://amsets.space", "https://www.amsets.space"]
   ```
7. **Встанови** rate limiting — вже налаштований у бекенді, перевір ліміти
8. **Аудит** смарт-контракту перед великим запуском (Sec3, OtterSec)

---

## Rollback (відкат у разі проблем)

### Frontend (Vercel)
1. Vercel → проект → **Deployments**
2. Знайди попередній успішний деплой
3. **⋮** → **Promote to Production**

### Backend (Railway)
1. Railway → сервіс → **Deployments**
2. Вибери попередній деплой → **Rollback**

### Смарт-контракт
Якщо контракт upgradeable — через Anchor:
```bash
anchor upgrade target/deploy/amsets_registry.so \
  --program-id PROGRAM_ID \
  --provider.cluster mainnet-beta
```
Якщо НЕ upgradeable — доведеться задеплоїти нову версію і мігрувати дані.

---

## Контакти та підтримка

- GitHub Issues: https://github.com/MikePasqualle/amsets/issues
- Founder: Michael Patsan
