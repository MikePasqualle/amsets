# AMSETS — Production Deployment Guide (Cloud + Mainnet)

> **Мета:** Повністю розгорнути платформу Amsets у хмарі на Solana Mainnet-Beta.  
> **Архітектура:** Frontend (Vercel) + Backend API (VPS/Railway) + PostgreSQL + Redis + Solana Mainnet

---

## Зміст

1. [Що потрібно підготувати заздалегідь](#1-підготовка)
2. [Розгортання смарт-контракту на Mainnet](#2-смарт-контракт-mainnet)
3. [Підготовка серверної інфраструктури](#3-інфраструктура)
4. [Деплой Backend API](#4-backend-api)
5. [Деплой Frontend на Vercel](#5-frontend-vercel)
6. [Фінальне налаштування та перевірка](#6-перевірка)
7. [Моніторинг і обслуговування](#7-моніторинг)
8. [Чек-лист перед запуском](#8-чек-лист)

---

## 1. Підготовка

### 1.1 Облікові записи (зареєструйтесь заздалегідь)

| Сервіс | Для чого | URL |
|--------|----------|-----|
| **Helius** | RPC-вузол Solana (mainnet) | [helius.dev](https://helius.dev) |
| **Livepeer Studio** | Відеосховище та CDN | [livepeer.studio](https://livepeer.studio) |
| **Pinata** | IPFS для preview-зображень | [pinata.cloud](https://pinata.cloud) |
| **Web3Auth** | Соціальна авторизація гаманця | [web3auth.io](https://web3auth.io) |
| **Vercel** | Хостинг фронтенду | [vercel.com](https://vercel.com) |
| **Railway або Hetzner/DigitalOcean** | VPS для backend API | — |
| **Upstash** | Redis у хмарі (або самохостинг) | [upstash.com](https://upstash.com) |
| **Neon або Supabase** | PostgreSQL у хмарі (або самохостинг) | [neon.tech](https://neon.tech) |

### 1.2 Гаманці Solana (потрібні НОВІ для продакшну)

Створіть **3 окремих гаманці** для продакшну. Ніколи не використовуйте гаманці з devnet!

```bash
# Встановити Solana CLI (якщо ще не встановлено)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Гаманець 1 — Program Upgrade Authority (deploy key)
solana-keygen new --outfile ~/amsets-keys/upgrade-authority.json
# ↑ Цей гаманець підписує деплой контракту.
# Зберігайте ДУЖЕ надійно. Потрібно ~5 SOL на деплой.

# Гаманець 2 — Mint Authority (backend server keypair)
solana-keygen new --outfile ~/amsets-keys/mint-authority.json
# ↑ Backend-сервер використовує цей гаманець для підпису mint-транзакцій.
# Потрібно ~0.5 SOL постійно на балансі.

# Гаманець 3 — Platform Fee Wallet (куди виводяться комісії)
solana-keygen new --outfile ~/amsets-keys/platform-fee.json
# ↑ Просто гаманець-отримувач. Може бути ваш основний гаманець.

# Подивитись адреси гаманців
solana-keygen pubkey ~/amsets-keys/upgrade-authority.json
solana-keygen pubkey ~/amsets-keys/mint-authority.json
solana-keygen pubkey ~/amsets-keys/platform-fee.json
```

> ⚠️ **Збережіть seed-фрази** усіх трьох гаманців в безпечному місці (менеджер паролів або апаратний гаманець). Втрата ключа upgrade-authority = неможливість оновити контракт.

---

## 2. Смарт-контракт на Mainnet

### 2.1 Перемкнути мережу на mainnet-beta

```bash
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/amsets-keys/upgrade-authority.json

# Перевірити баланс (потрібно ~5 SOL для деплою)
solana balance
```

### 2.2 Скомпілювати контракт

```bash
cd /path/to/amsets-contracts

# Збірка (обходить проблему з toolchain)
RUSTUP_TOOLCHAIN="1.84.1-sbpf-solana-v1.51" \
  cargo build --target sbpf-solana-solana --release -p amsets-registry

# .so файл буде тут:
ls target/sbpf-solana-solana/release/amsets_registry.so
```

### 2.3 Задеплоїти на mainnet

> ⚠️ Перший деплой створить НОВИЙ Program ID. Запишіть його — він буде використовуватись скрізь.

```bash
# Перший деплой — отримаємо новий Program ID
solana program deploy \
  --url https://mainnet.helius-rpc.com/?api-key=ВАШ_HELIUS_KEY \
  target/sbpf-solana-solana/release/amsets_registry.so

# Виведе щось на кшталт:
# Program Id: НОВИЙ_PROGRAM_ID
# Signature: ...

# Збережіть НОВИЙ_PROGRAM_ID — він потрібен у .env
```

### 2.4 Ініціалізувати PDA-рахунки

Після деплою потрібно один раз ініціалізувати синглтон-рахунки:

```bash
cd /path/to/amsets-app

# Встановити залежності якщо ще не
npm install

# Запустити ініціалізацію (потрібен RPC та ключ upgrade-authority)
SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=ВАШ_HELIUS_KEY" \
PROGRAM_ID="НОВИЙ_PROGRAM_ID" \
MINT_AUTHORITY_SECRET="$(cat ~/amsets-keys/mint-authority.json)" \
  node scripts/init-registry.js
```

> Якщо скрипту немає — ініціалізацію можна зробити через адмін-панель фронтенду після розгортання, або вручну через Anchor CLI.

---

## 3. Інфраструктура

### Варіант A: Повний самохостинг (VPS — рекомендовано для контролю)

**Рекомендований сервер:** Hetzner CX21 або DigitalOcean Droplet  
- CPU: 2 vCPU  
- RAM: 4 GB  
- Диск: 40 GB SSD  
- OS: Ubuntu 22.04 LTS  
- Ціна: ~$5–10/міс

```bash
# Підключитись до сервера
ssh root@ВАШ_IP

# Оновити систему
apt update && apt upgrade -y

# Встановити Docker + Docker Compose
curl -fsSL https://get.docker.com | sh
apt install -y docker-compose-plugin

# Встановити Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Встановити PM2 (процес-менеджер для Node.js)
npm install -g pm2

# Встановити Nginx (реверс-проксі)
apt install -y nginx certbot python3-certbot-nginx

# Створити директорію для проєкту
mkdir -p /opt/amsets
```

### Варіант B: Railway (простіше, але дорожче)

Railway автоматично деплоїть з GitHub. Потрібно лише додати env-змінні. Дивіться розділ 4.2.

---

## 4. Backend API

### 4.1 Клонувати репозиторій на сервер

```bash
cd /opt/amsets

# Клонувати з GitHub
git clone https://github.com/MikePasqualle/amsets.git .

# АБО скопіювати через rsync з локальної машини:
# rsync -av --exclude node_modules --exclude .git \
#   "/Users/mikepatsan/PY Projects/Amsets Dev/" root@ВАШ_IP:/opt/amsets/
```

### 4.2 Запустити PostgreSQL і Redis через Docker

```bash
cd /opt/amsets

# Запустити тільки базу і Redis (без solana-validator)
docker compose up -d postgres redis

# Перевірити що запустились
docker compose ps
docker compose logs postgres | tail -5
```

### 4.3 Налаштувати змінні середовища для API

```bash
cp /opt/amsets/amsets-api/.env.example /opt/amsets/amsets-api/.env
nano /opt/amsets/amsets-api/.env
```

Заповніть файл (замініть всі значення на реальні):

```env
# ─── Server ───────────────────────────────────────────────────────────────────
PORT=3001
NODE_ENV=production

# ─── Database ─────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://amsets:СИЛЬНИЙ_ПАРОЛЬ@127.0.0.1:5432/amsets_db

# ─── Redis ────────────────────────────────────────────────────────────────────
REDIS_URL=redis://127.0.0.1:6379

# ─── JWT (згенеруйте новий) ───────────────────────────────────────────────────
JWT_SECRET=ТРИВАЛИЙ_РАНДОМНИЙ_РЯДОК_64_СИМВОЛИ
JWT_EXPIRES_IN=180d

# ─── Solana MAINNET ──────────────────────────────────────────────────────────
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=ВАШ_HELIUS_KEY
HELIUS_API_KEY=ВАШ_HELIUS_KEY
PROGRAM_ID=НОВИЙ_PROGRAM_ID_З_MAINNET

# ─── Mint Authority keypair ───────────────────────────────────────────────────
# Беремо вміст файлу як JSON-масив байтів
MINT_AUTHORITY_SECRET=ВАШ_ПРИВАТНИЙ_КЛЮЧ_MINT_AUTHORITY_BASE58

# ─── Withdraw Authority (той самий keypair що деплоїв контракт) ───────────────
# Шлях до файлу або BASE58 ключ
WITHDRAW_AUTHORITY_KEYPAIR=/opt/amsets/keys/upgrade-authority.json

# ─── Admin ────────────────────────────────────────────────────────────────────
ADMIN_SECRET=ДОВГИЙ_СЕКРЕТНИЙ_РЯДОК_ДЛЯ_АДМІНКИ

# ─── Pinata IPFS ──────────────────────────────────────────────────────────────
PINATA_JWT=ВАШ_PINATA_JWT
PINATA_GATEWAY=https://gateway.pinata.cloud

# ─── Livepeer Studio ──────────────────────────────────────────────────────────
LIVEPEER_API_KEY=ВАШ_LIVEPEER_API_KEY
LIVEPEER_SIGNING_KEY_ID=ВАШ_LIVEPEER_SIGNING_KEY_ID
LIVEPEER_PRIVATE_KEY=ВАШ_LIVEPEER_PRIVATE_KEY_BASE64
```

> **Як отримати MINT_AUTHORITY_SECRET:**
> ```bash
> # Конвертувати JSON keypair → base58
> node -e "
> const fs = require('fs');
> const bs58 = require('bs58');
> const key = JSON.parse(fs.readFileSync('~/amsets-keys/mint-authority.json', 'utf8'));
> console.log(bs58.encode(Buffer.from(key)));
> "
> ```

### 4.4 Скопіювати ключі на сервер

```bash
# З локальної машини
scp ~/amsets-keys/upgrade-authority.json root@ВАШ_IP:/opt/amsets/keys/
chmod 600 /opt/amsets/keys/upgrade-authority.json
```

### 4.5 Встановити залежності та збудувати API

```bash
cd /opt/amsets/amsets-api

npm install

# Скомпілювати TypeScript
npm run build

# Застосувати міграції бази даних
npm run db:migrate
```

### 4.6 Запустити API через PM2

```bash
cd /opt/amsets/amsets-api

# Запустити
pm2 start dist/index.js --name amsets-api

# Зберегти конфігурацію PM2 (щоб рестартував після reboot)
pm2 save
pm2 startup
# Виконайте команду яку виведе pm2 startup

# Перевірити логи
pm2 logs amsets-api --lines 50
```

### 4.7 Налаштувати Nginx для API

```bash
nano /etc/nginx/sites-available/amsets-api
```

```nginx
server {
    listen 80;
    server_name api.ВАШДОМЕН.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Для великих файлів (upload)
        client_max_body_size 500M;
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
    }
}
```

```bash
# Увімкнути сайт
ln -s /etc/nginx/sites-available/amsets-api /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL сертифікат (Let's Encrypt)
certbot --nginx -d api.ВАШДОМЕН.com
```

---

## 5. Frontend на Vercel

### 5.1 Підключити репозиторій до Vercel

1. Зайдіть на [vercel.com](https://vercel.com)
2. Натисніть **New Project** → **Import Git Repository**
3. Виберіть репозиторій `amsets`
4. **Root Directory:** `amsets-app`
5. **Build Command:** `npm run build`
6. **Output Directory:** `.next`

### 5.2 Налаштувати Environment Variables у Vercel

У налаштуваннях проєкту → **Environment Variables** додайте:

```env
# API Backend
NEXT_PUBLIC_API_URL=https://api.ВАШДОМЕН.com

# Solana MAINNET
NEXT_PUBLIC_SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=ВАШ_HELIUS_KEY
NEXT_PUBLIC_PROGRAM_ID=НОВИЙ_PROGRAM_ID_З_MAINNET

# Web3Auth (mainnet конфігурація)
NEXT_PUBLIC_WEB3AUTH_CLIENT_ID=ВАШ_WEB3AUTH_CLIENT_ID

# Pinata IPFS
NEXT_PUBLIC_PINATA_JWT=ВАШ_PINATA_JWT
NEXT_PUBLIC_PINATA_GATEWAY=https://gateway.pinata.cloud

# Arweave (mainnet)
NEXT_PUBLIC_IRYS_NETWORK=mainnet
NEXT_PUBLIC_ARWEAVE_GATEWAY=https://arweave.net

# Mint Authority public key (тільки публічний!)
NEXT_PUBLIC_MINT_AUTHORITY_PUBKEY=ПУБЛІЧНИЙ_КЛЮЧ_MINT_AUTHORITY
```

> ⚠️ У Vercel ніколи не додавайте приватні ключі. Тільки `NEXT_PUBLIC_` змінні.

### 5.3 Деплой

```bash
# Vercel автоматично деплоїть при push в main
git push origin main

# АБО вручну через CLI
npm install -g vercel
cd amsets-app
vercel --prod
```

### 5.4 Налаштувати домен

У Vercel → Settings → Domains → додайте `ВАШДОМЕН.com`  
Додайте DNS-запис у вашого реєстратора домену (CNAME або A-запис).

---

## 6. Перевірка

### 6.1 Перевірити що контракт задеплоєний на mainnet

```bash
solana program show НОВИЙ_PROGRAM_ID \
  --url https://mainnet.helius-rpc.com/?api-key=ВАШ_HELIUS_KEY
```

Повинно показати:
```
Program Id: НОВИЙ_PROGRAM_ID
Owner: BPFLoaderUpgradeab1e11111111111111111111111
ProgramData Address: ...
Authority: ВАШ_UPGRADE_AUTHORITY
Last Deployed In Slot: ...
Data Length: ...
Balance: ...
```

### 6.2 Перевірити backend API

```bash
curl https://api.ВАШДОМЕН.com/health
# Відповідь: {"status":"ok","timestamp":...}

curl https://api.ВАШДОМЕН.com/api/v1/marketplace/stats
# Відповідь: {"source":"chain","totalContent":0,...}
```

### 6.3 Перевірити Frontend

Відкрийте `https://ВАШДОМЕН.com` у браузері:
- [ ] Підключити Phantom гаманець
- [ ] Переконатись що мережа = **Mainnet Beta** (не Devnet)
- [ ] Завантажити тестовий контент
- [ ] Переконатись що транзакція проходить на mainnet

### 6.4 Ініціалізувати FeeVault (один раз)

Після першого деплою потрібно ініціалізувати FeeVault PDA:

```bash
# Зайдіть в адмін-панель: https://ВАШДОМЕН.com/admin
# Або через curl:
curl -X POST https://api.ВАШДОМЕН.com/api/v1/admin/init-vault \
  -H "X-Admin-Secret: ВАШ_ADMIN_SECRET"
```

---

## 7. Моніторинг

### 7.1 Логи PM2

```bash
# Реальний час
pm2 logs amsets-api --lines 100

# Зберегти логи у файл
pm2 logs amsets-api --lines 1000 > /tmp/api-logs.txt
```

### 7.2 Стан бази даних

```bash
docker exec amsets-postgres psql -U amsets -d amsets_db -c "
SELECT 
  (SELECT COUNT(*) FROM content) as content,
  (SELECT COUNT(*) FROM purchases) as purchases,
  (SELECT COUNT(*) FROM listings WHERE status='active') as active_listings;
"
```

### 7.3 Стан гаманців (адмін-панель)

Відкрийте `https://ВАШДОМЕН.com/admin` → розділ **Гаманці**:
- FeeVault: накопичені комісії (кнопка "Вивести комісії")
- Mint Authority: повинен мати > 0.05 SOL
- Platform Fee Wallet: куди приходять виведені комісії

### 7.4 Автоматичні оновлення

```bash
# Скрипт оновлення (зберегти як /opt/amsets/update.sh)
cat > /opt/amsets/update.sh << 'EOF'
#!/bin/bash
cd /opt/amsets
git pull origin main
cd amsets-api
npm install
npm run build
npm run db:migrate
pm2 restart amsets-api
echo "API updated: $(date)"
EOF
chmod +x /opt/amsets/update.sh

# Запускати вручну після кожного push:
# /opt/amsets/update.sh
```

---

## 8. Чек-лист перед запуском

### Смарт-контракт
- [ ] Контракт задеплоєний на **mainnet-beta** (не devnet)
- [ ] Program ID оновлений у всіх `.env` файлах
- [ ] `RegistryState` PDA ініціалізований (`initialize_registry`)
- [ ] `FeeVault` PDA ініціалізований (`initialize_vault`)
- [ ] Upgrade-authority keypair збережений надійно

### Backend API
- [ ] `NODE_ENV=production`
- [ ] `SOLANA_RPC_URL` вказує на **mainnet** Helius
- [ ] `DATABASE_URL` — продакшн PostgreSQL з сильним паролем
- [ ] `JWT_SECRET` — новий, довгий рядок (мінімум 64 символи)
- [ ] `MINT_AUTHORITY_SECRET` — mainnet keypair (не devnet)
- [ ] `ADMIN_SECRET` — надійний секретний рядок
- [ ] Міграції бази виконані (`npm run db:migrate`)
- [ ] PM2 запущений і збережений (`pm2 save`)
- [ ] SSL-сертифікат встановлений (`certbot`)
- [ ] Mint Authority гаманець поповнений (мінімум 0.5 SOL)

### Frontend
- [ ] `NEXT_PUBLIC_SOLANA_RPC_URL` → mainnet Helius URL
- [ ] `NEXT_PUBLIC_PROGRAM_ID` → mainnet Program ID
- [ ] `NEXT_PUBLIC_IRYS_NETWORK=mainnet`
- [ ] `NEXT_PUBLIC_API_URL` → продакшн URL бекенду
- [ ] Vercel деплой успішний
- [ ] Власний домен підключений і SSL активний

### Безпека
- [ ] Приватні ключі НЕ в git-репозиторії (перевірте `.gitignore`)
- [ ] `ADMIN_SECRET` змінений з дефолтного
- [ ] Файерволл сервера: відкриті тільки порти 80, 443, 22
- [ ] SSH доступ тільки по ключу (не паролю)
- [ ] Резервна копія seed-фраз усіх гаманців

---

## Додаток: Корисні команди

```bash
# Перевірити баланс mainnet гаманців
solana balance ВАШ_UPGRADE_AUTHORITY --url mainnet-beta
solana balance ВАШ_MINT_AUTHORITY --url mainnet-beta

# Перезапустити API після змін
pm2 restart amsets-api && pm2 logs amsets-api --lines 20

# Резервна копія PostgreSQL
docker exec amsets-postgres pg_dump -U amsets amsets_db > backup-$(date +%Y%m%d).sql

# Відновити PostgreSQL з бекапу
docker exec -i amsets-postgres psql -U amsets amsets_db < backup-20260301.sql

# Перевірити статус всіх сервісів
docker compose ps
pm2 status
systemctl status nginx

# Оновити SSL сертифікат
certbot renew --nginx
```

---

> **Підтримка:** Якщо щось не працює — перевірте логи `pm2 logs amsets-api` та `docker compose logs postgres`. 99% проблем вирішуються там.
