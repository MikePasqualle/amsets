"use client";

import { useState, useEffect, useCallback } from "react";
import { GlowButton } from "@/components/ui/GlowButton";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Settings {
  platform_fee_wallet?: string;
  platform_name?: string;
  platform_fee_bps?: string;
  fee_vault_pda?: string;
  fee_vault_balance?: string;
}

interface Stats {
  purchases: number;
  total_revenue_sol: string;
  platform_revenue_sol: string;
  fee_vault_balance_sol: string;
  fee_vault_pda: string;
  content: number;
  users: number;
}

interface WalletInfo {
  name: string;
  address: string;
  balanceSol: string;
  balanceLam: number;
  withdrawable: number;
  purpose: string;
  needsTopUp: boolean;
  minBalance: number;
  status: "ok" | "low" | "critical" | "empty";
  canWithdraw: boolean;
}

interface WithdrawResult {
  ok: boolean;
  signature: string;
  withdrawnSol: string;
  recipient: string;
  explorerUrl: string;
}

const STATUS_COLORS = {
  ok:       "text-[#81D0B5]",
  low:      "text-[#F7FF88]",
  critical: "text-red-400",
  empty:    "text-[#7A6E8E]",
};

const STATUS_LABELS = {
  ok:       "✅ Норма",
  low:      "⚠️ Низький",
  critical: "🚨 Критичний",
  empty:    "— Порожній",
};

export default function AdminSettingsPage() {
  const [secret, setSecret]         = useState("");
  const [authed, setAuthed]         = useState(false);
  const [settings, setSettings]     = useState<Settings>({});
  const [stats, setStats]           = useState<Stats | null>(null);
  const [wallets, setWallets]       = useState<WalletInfo[]>([]);
  const [saving, setSaving]         = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<WithdrawResult | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [success, setSuccess]       = useState<string | null>(null);

  const [feeWallet, setFeeWallet]   = useState("");
  const [feeBps, setFeeBps]         = useState("250");

  const load = useCallback(async (s: string) => {
    setError(null);
    const [sRes, stRes, wRes] = await Promise.all([
      fetch(`${API_URL}/api/v1/admin/settings`, { headers: { "X-Admin-Secret": s } }),
      fetch(`${API_URL}/api/v1/admin/stats`,    { headers: { "X-Admin-Secret": s } }),
      fetch(`${API_URL}/api/v1/admin/wallets`,  { headers: { "X-Admin-Secret": s } }),
    ]);

    if (!sRes.ok) { setError("Невірний admin secret"); return; }

    const { settings: s2 } = await sRes.json();
    const st  = stRes.ok  ? await stRes.json()  : null;
    const wd  = wRes.ok   ? await wRes.json()   : { wallets: [] };

    setSettings(s2);
    setStats(st);
    setWallets(wd.wallets ?? []);
    setFeeWallet(s2.platform_fee_wallet ?? "");
    setFeeBps(s2.platform_fee_bps ?? "250");
    setAuthed(true);
  }, []);

  const handleLogin = (e: React.FormEvent) => { e.preventDefault(); load(secret); };

  const handleSave = async () => {
    setSaving(true);
    setSuccess(null);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/admin/settings`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": secret },
        body:    JSON.stringify({ platform_fee_wallet: feeWallet, platform_fee_bps: feeBps }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      setSuccess("Налаштування збережено.");
      await load(secret);
    } catch (err: any) {
      setError(err?.message ?? "Помилка збереження");
    } finally {
      setSaving(false);
    }
  };

  const handleWithdraw = async () => {
    if (!confirm(`Вивести всі комісії з FeeVault на гаманець:\n${feeWallet || settings.platform_fee_wallet}\n\nПродовжити?`)) return;
    setWithdrawing(true);
    setWithdrawResult(null);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/admin/withdraw-fees`, {
        method:  "POST",
        headers: { "X-Admin-Secret": secret },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Помилка виводу");
      setWithdrawResult(data as WithdrawResult);
      setSuccess(`✅ Виведено ${data.withdrawnSol} SOL → ${data.recipient}`);
      await load(secret);
    } catch (err: any) {
      setError(err?.message ?? "Вивід не вдався");
    } finally {
      setWithdrawing(false);
    }
  };

  if (!authed) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#0D0A14] px-4">
        <form onSubmit={handleLogin} className="flex flex-col gap-4 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-[#EDE8F5]">Admin Panel</h1>
          <p className="text-[#7A6E8E] text-sm">Введіть admin secret для входу.</p>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Admin secret"
            className="bg-[#1A1025] border border-[#3D2F5A] rounded-xl px-4 py-3 text-[#EDE8F5] text-sm outline-none focus:border-[#81D0B5] transition-colors"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <GlowButton type="submit" variant="primary">Увійти</GlowButton>
        </form>
      </main>
    );
  }

  const feeVaultWallet = wallets.find(w => w.canWithdraw);
  const withdrawableSol = feeVaultWallet
    ? (feeVaultWallet.withdrawable / 1e9).toFixed(6)
    : "0";

  return (
    <main className="min-h-screen bg-[#0D0A14] px-6 py-12">
      <div className="max-w-4xl mx-auto flex flex-col gap-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[#EDE8F5]">Admin Panel</h1>
            <p className="text-[#7A6E8E] text-sm mt-1">AMSETS Platform Management</p>
          </div>
          <span className="text-xs text-[#7A6E8E] font-mono bg-[#1A1025] px-3 py-1 rounded-full border border-[#3D2F5A]">
            Devnet
          </span>
        </div>

        {/* Stats overview */}
        {stats && (
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "Покупки",           value: stats.purchases },
              { label: "Дохід платформи",   value: `◎ ${stats.platform_revenue_sol}` },
              { label: "FeeVault баланс",   value: `◎ ${stats.fee_vault_balance_sol}` },
              { label: "Контент / Юзери",   value: `${stats.content} / ${stats.users}` },
            ].map(({ label, value }) => (
              <div key={label} className="bg-[#1A1025] border border-[#3D2F5A] rounded-xl p-4">
                <p className="text-[#7A6E8E] text-xs mb-1">{label}</p>
                <p className="text-[#F7FF88] font-bold text-lg">{value}</p>
              </div>
            ))}
          </section>
        )}

        {/* ── Wallet Monitoring ── */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[#EDE8F5] font-semibold text-xl">Гаманці платформи</h2>
            <button
              onClick={() => load(secret)}
              className="text-xs text-[#7A6E8E] hover:text-[#81D0B5] transition-colors"
            >
              ↻ Оновити
            </button>
          </div>

          {wallets.map((w) => (
            <div
              key={w.address}
              className={`bg-[#1A1025] border rounded-2xl p-5 flex flex-col gap-3 ${
                w.status === "critical" ? "border-red-500/60" :
                w.status === "low"     ? "border-[#F7FF88]/40" :
                                          "border-[#3D2F5A]"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[#EDE8F5] font-semibold">{w.name}</p>
                  <a
                    href={`https://solscan.io/account/${w.address}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#81D0B5] font-mono text-xs underline break-all"
                  >
                    {w.address}
                  </a>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[#F7FF88] font-bold text-xl">◎ {w.balanceSol}</p>
                  <p className={`text-xs font-medium mt-0.5 ${STATUS_COLORS[w.status]}`}>
                    {STATUS_LABELS[w.status]}
                  </p>
                </div>
              </div>

              <p className="text-[#7A6E8E] text-sm">{w.purpose}</p>

              {w.needsTopUp && (
                <div className="bg-[#F7FF88]/10 border border-[#F7FF88]/30 rounded-xl px-4 py-2">
                  <p className="text-[#F7FF88] text-xs">
                    ⚠️ Поповніть гаманець! Мінімальний рекомендований баланс:{" "}
                    <strong>◎ {(w.minBalance / 1e9).toFixed(3)} SOL</strong>.
                    Без SOL на цьому гаманці мінтинг токенів доступу зупиниться.
                  </p>
                </div>
              )}

              {w.canWithdraw && (
                <div className="flex items-center justify-between bg-[#81D0B5]/10 border border-[#81D0B5]/30 rounded-xl px-4 py-3">
                  <div>
                    <p className="text-[#81D0B5] text-sm font-semibold">
                      Доступно для виводу: ◎ {withdrawableSol} SOL
                    </p>
                    <p className="text-[#7A6E8E] text-xs mt-0.5">
                      Залишок ~0.00089 SOL (мінімум для rent-exempt)
                    </p>
                  </div>
                  <GlowButton
                    variant="primary"
                    size="sm"
                    onClick={handleWithdraw}
                    isLoading={withdrawing}
                    disabled={w.withdrawable <= 0 || withdrawing}
                  >
                    Вивести комісії
                  </GlowButton>
                </div>
              )}
            </div>
          ))}
        </section>

        {/* Withdraw result */}
        {withdrawResult && (
          <section className="bg-[#81D0B5]/10 border border-[#81D0B5]/40 rounded-2xl p-5 flex flex-col gap-2">
            <p className="text-[#81D0B5] font-semibold">✅ Вивід успішний!</p>
            <p className="text-sm text-[#EDE8F5]">
              Виведено <strong>◎ {withdrawResult.withdrawnSol} SOL</strong> на{" "}
              <span className="font-mono text-xs">{withdrawResult.recipient}</span>
            </p>
            <a
              href={withdrawResult.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#81D0B5] underline text-xs font-mono"
            >
              Переглянути транзакцію на Solscan →
            </a>
          </section>
        )}

        {/* ── Platform Configuration ── */}
        <section className="bg-[#1A1025] border border-[#3D2F5A] rounded-2xl p-6 flex flex-col gap-5">
          <h2 className="text-[#EDE8F5] font-semibold text-lg">Налаштування платформи</h2>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-[#7A6E8E]">
              Platform Fee Wallet
              <span className="ml-2 text-xs text-[#3D2F5A]">(гаманець для виводу комісій)</span>
            </label>
            <input
              value={feeWallet}
              onChange={(e) => setFeeWallet(e.target.value)}
              placeholder="Solana wallet address"
              className="bg-[#0D0A14] border border-[#3D2F5A] rounded-xl px-4 py-3 text-[#EDE8F5] text-sm font-mono outline-none focus:border-[#81D0B5] transition-colors"
            />
            <p className="text-xs text-[#7A6E8E]">
              На цей гаманець будуть зараховані всі виведені комісії з FeeVault.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-[#7A6E8E]">
              Platform Fee (bps)
              <span className="ml-2 text-xs text-[#3D2F5A]">(250 = 2.5%)</span>
            </label>
            <input
              type="number"
              value={feeBps}
              onChange={(e) => setFeeBps(e.target.value)}
              min={0}
              max={1000}
              className="bg-[#0D0A14] border border-[#3D2F5A] rounded-xl px-4 py-3 text-[#EDE8F5] text-sm outline-none focus:border-[#81D0B5] transition-colors w-40"
            />
            <p className="text-xs text-[#7A6E8E]">
              Поточна комісія: {Number(feeBps) / 100}% з кожного первинного продажу
            </p>
          </div>

          {error   && <p className="text-red-400 text-sm">{error}</p>}
          {success && <p className="text-green-400 text-sm">{success}</p>}

          <GlowButton variant="primary" onClick={handleSave} isLoading={saving}>
            Зберегти налаштування
          </GlowButton>
        </section>

        {/* ── System Info ── */}
        <section className="bg-[#1A1025] border border-[#3D2F5A] rounded-2xl p-6 flex flex-col gap-3">
          <h2 className="text-[#EDE8F5] font-semibold text-lg">Системна інформація</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {[
              { label: "Контент на платформі",  value: stats?.content ?? "—" },
              { label: "Зареєстровані юзери",    value: stats?.users   ?? "—" },
              { label: "Мережа Solana",           value: "Devnet" },
              { label: "Program ID",              value: "B2gRbiH…xatG" },
              { label: "FeeVault PDA",            value: settings.fee_vault_pda?.slice(0, 20) + "…" },
              { label: "Загальний дохід",         value: `◎ ${stats?.total_revenue_sol ?? "0"}` },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between border-b border-[#3D2F5A] pb-2">
                <span className="text-[#7A6E8E]">{label}</span>
                <span className="text-[#EDE8F5] font-mono text-xs">{value}</span>
              </div>
            ))}
          </div>
        </section>

      </div>
    </main>
  );
}
