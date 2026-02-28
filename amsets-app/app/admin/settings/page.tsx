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

export default function AdminSettingsPage() {
  const [secret, setSecret]       = useState("");
  const [authed, setAuthed]       = useState(false);
  const [settings, setSettings]   = useState<Settings>({});
  const [stats, setStats]         = useState<Stats | null>(null);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [success, setSuccess]     = useState<string | null>(null);

  // Editable fields
  const [feeWallet, setFeeWallet]   = useState("");
  const [feeBps, setFeeBps]         = useState("250");

  const load = useCallback(async (s: string) => {
    setError(null);
    const [sRes, stRes] = await Promise.all([
      fetch(`${API_URL}/api/v1/admin/settings`, { headers: { "X-Admin-Secret": s } }),
      fetch(`${API_URL}/api/v1/admin/stats`,    { headers: { "X-Admin-Secret": s } }),
    ]);

    if (!sRes.ok) { setError("Invalid admin secret"); return; }

    const { settings: s2 } = await sRes.json();
    const st = stRes.ok ? await stRes.json() : null;

    setSettings(s2);
    setStats(st);
    setFeeWallet(s2.platform_fee_wallet ?? "");
    setFeeBps(s2.platform_fee_bps ?? "250");
    setAuthed(true);
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    load(secret);
  };

  const handleSave = async () => {
    setSaving(true);
    setSuccess(null);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/admin/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": secret },
        body: JSON.stringify({
          platform_fee_wallet: feeWallet,
          platform_fee_bps:    feeBps,
        }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      setSuccess("Settings saved successfully.");
      await load(secret);
    } catch (err: any) {
      setError(err?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!authed) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-[#0D0A14] px-4">
        <form onSubmit={handleLogin} className="flex flex-col gap-4 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-[#EDE8F5]">Admin Settings</h1>
          <p className="text-[#7A6E8E] text-sm">Enter admin secret to continue.</p>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Admin secret"
            className="bg-[#1A1025] border border-[#3D2F5A] rounded-xl px-4 py-3 text-[#EDE8F5] text-sm outline-none focus:border-[#81D0B5] transition-colors"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <GlowButton type="submit" variant="primary">Enter</GlowButton>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0D0A14] px-6 py-12">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-[#EDE8F5]">Admin Settings</h1>
          <span className="text-xs text-[#7A6E8E] font-mono bg-[#1A1025] px-3 py-1 rounded-full border border-[#3D2F5A]">
            AMSETS Admin
          </span>
        </div>

        {/* ── Stats ── */}
        {stats && (
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "Total Purchases", value: stats.purchases },
              { label: "Total Revenue", value: `◎ ${stats.total_revenue_sol}` },
              { label: "Platform Revenue (2.5%)", value: `◎ ${stats.platform_revenue_sol}` },
              { label: "FeeVault Balance", value: `◎ ${stats.fee_vault_balance_sol}` },
            ].map(({ label, value }) => (
              <div key={label} className="bg-[#1A1025] border border-[#3D2F5A] rounded-xl p-4">
                <p className="text-[#7A6E8E] text-xs mb-1">{label}</p>
                <p className="text-[#F7FF88] font-bold text-lg">{value}</p>
              </div>
            ))}
          </section>
        )}

        {/* ── FeeVault info ── */}
        <section className="bg-[#1A1025] border border-[#3D2F5A] rounded-2xl p-6 flex flex-col gap-3">
          <h2 className="text-[#EDE8F5] font-semibold text-lg">Fee Vault (On-chain)</h2>
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-[#7A6E8E]">FeeVault PDA</span>
              <a
                href={`https://solscan.io/account/${settings.fee_vault_pda}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#81D0B5] font-mono text-xs underline break-all"
              >
                {settings.fee_vault_pda}
              </a>
            </div>
            <div className="flex justify-between">
              <span className="text-[#7A6E8E]">Accumulated fees</span>
              <span className="text-[#F7FF88] font-bold">◎ {settings.fee_vault_balance}</span>
            </div>
          </div>
          <p className="text-xs text-[#7A6E8E] mt-2">
            Primary-sale fees go to the FeeVault PDA on-chain (controlled by the smart contract program authority).
            To withdraw, call the <code className="text-[#81D0B5]">withdraw_fees</code> instruction with the program upgrade authority.
          </p>
        </section>

        {/* ── Editable settings ── */}
        <section className="bg-[#1A1025] border border-[#3D2F5A] rounded-2xl p-6 flex flex-col gap-5">
          <h2 className="text-[#EDE8F5] font-semibold text-lg">Platform Configuration</h2>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-[#7A6E8E]">
              Platform Fee Wallet
              <span className="ml-2 text-xs text-[#3D2F5A]">(receives secondary-sale fees)</span>
            </label>
            <input
              value={feeWallet}
              onChange={(e) => setFeeWallet(e.target.value)}
              placeholder="Solana wallet address"
              className="bg-[#0D0A14] border border-[#3D2F5A] rounded-xl px-4 py-3 text-[#EDE8F5] text-sm font-mono outline-none focus:border-[#81D0B5] transition-colors"
            />
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
              Current: {Number(feeBps) / 100}% per transaction
            </p>
          </div>

          {error   && <p className="text-red-400 text-sm">{error}</p>}
          {success && <p className="text-green-400 text-sm">{success}</p>}

          <GlowButton variant="primary" onClick={handleSave} isLoading={saving}>
            Save Settings
          </GlowButton>
        </section>

        {/* ── Additional info ── */}
        <section className="bg-[#1A1025] border border-[#3D2F5A] rounded-2xl p-6 flex flex-col gap-3">
          <h2 className="text-[#EDE8F5] font-semibold text-lg">System Information</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {[
              { label: "Total Content Items", value: stats?.content ?? "—" },
              { label: "Registered Users",     value: stats?.users ?? "—" },
              { label: "Network",              value: "Solana Devnet" },
              { label: "Program ID",           value: "B2gRbiH...xatG" },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between border-b border-[#3D2F5A] pb-2">
                <span className="text-[#7A6E8E]">{label}</span>
                <span className="text-[#EDE8F5] font-mono">{value}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
