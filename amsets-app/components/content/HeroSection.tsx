"use client";

import { useRef, useState, useEffect } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { GlowButton } from "@/components/ui/GlowButton";
import { useAuthModal } from "@/providers/AuthContext";
import { useLogoReveal } from "@/components/animations/useLogoReveal";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Hero section of the Marketplace page.
 * Animations:
 *   1. Logo "AMSETS" — stagger letter reveal (per useLogoReveal)
 *   2. Tagline — fade in, delay 0.6s
 *   3. CTA button — scale 0.8→1 with glow pulse
 *   4. Background — radial gradient pulse animation
 */
export function HeroSection() {
  const heroRef = useRef<HTMLDivElement | null>(null);
  const taglineRef = useRef<HTMLParagraphElement | null>(null);
  const ctaRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLDivElement | null>(null);

  const router = useRouter();
  const { connected } = useWallet();
  const { openAuth } = useAuthModal();

  // Web3Auth session lives in localStorage — same check used by UploadSteps & ConnectButton
  const [hasWeb3AuthSession, setHasWeb3AuthSession] = useState(false);
  useEffect(() => {
    const sync = () => setHasWeb3AuthSession(!!localStorage.getItem("amsets_wallet"));
    sync();
    window.addEventListener("amsets_session_changed", sync);
    return () => window.removeEventListener("amsets_session_changed", sync);
  }, []);

  const isAuthenticated = connected || hasWeb3AuthSession;

  // Real-time stats from the on-chain RegistryState PDA (via /api/v1/marketplace/stats)
  const [stats, setStats] = useState({ works: 0, purchases: 0, solVolume: "0" });
  useEffect(() => {
    async function fetchStats() {
      try {
        // Primary: on-chain RegistryState aggregated stats
        const statsRes = await fetch(`${API_URL}/api/v1/marketplace/stats`);
        if (statsRes.ok) {
          const data = await statsRes.json();
          setStats({
            works:     data.totalContent     ?? 0,
            purchases: data.totalPurchases   ?? 0,
            solVolume: data.totalSolVolumeSol ?? "0",
          });
          return;
        }
      } catch {
        // fall through to marketplace fallback
      }
      try {
        // Fallback: count from marketplace listing
        const res = await fetch(`${API_URL}/api/v1/marketplace?limit=1`);
        if (!res.ok) return;
        const data = await res.json();
        setStats({ works: data.total ?? 0, purchases: 0, solVolume: "0" });
      } catch {
        // Non-fatal — keep defaults
      }
    }
    fetchStats();
  }, []);

  const logoRef = useLogoReveal("AMSETS");

  /**
   * "Start Publishing" logic:
   * - Wallet Adapter (Phantom/Solflare) OR Web3Auth (email/phone/social) → /upload
   * - Not authenticated at all → open AuthModal
   */
  function handleStartPublishing() {
    if (isAuthenticated) {
      router.push("/upload");
    } else {
      openAuth();
    }
  }

  useGSAP(
    () => {
      // Tagline fade in
      if (taglineRef.current) {
        gsap.fromTo(
          taglineRef.current,
          { opacity: 0, y: 10 },
          { opacity: 1, y: 0, duration: 0.6, ease: "power2.out", delay: 0.7 }
        );
      }

      // CTA scale in
      if (ctaRef.current) {
        gsap.fromTo(
          ctaRef.current,
          { opacity: 0, scale: 0.8 },
          { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(1.5)", delay: 1 }
        );
      }

      // Background radial gradient pulse
      if (bgRef.current) {
        gsap.to(bgRef.current, {
          backgroundSize: "110% 110%",
          repeat: -1,
          yoyo: true,
          duration: 4,
          ease: "sine.inOut",
        });
      }
    },
    { scope: heroRef }
  );

  return (
    <>
      <section
        ref={heroRef}
        className="relative flex flex-col items-center justify-center text-center px-6 pt-40 pb-24 overflow-hidden"
      >
        {/* Animated background gradient */}
        <div
          ref={bgRef}
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(34,21,51,0.9) 0%, rgba(13,10,20,0) 70%)",
            backgroundSize: "100% 100%",
          }}
        />

        {/* Main heading with letter reveal */}
        <div className="relative z-10 flex flex-col items-center gap-4">
          <div className="overflow-hidden">
            <span
              ref={logoRef}
              className="block text-7xl md:text-8xl lg:text-9xl font-black tracking-tight"
              style={{ color: "#F7FF88" }}
            />
          </div>

          <p
            ref={taglineRef}
            className="text-xl md:text-2xl font-light text-[#81D0B5] max-w-xl opacity-0"
          >
            The decentralized ledger for intellectual property rights on Solana
          </p>

          <p className="text-[#7A6E8E] text-base max-w-lg">
            Register your work on-chain, set a price, share a link. Buyers receive an
            access token that proves ownership and grants streaming rights — enforced by smart contract.
          </p>

          <div ref={ctaRef} className="flex gap-4 mt-6 opacity-0">
            <GlowButton variant="primary" size="lg" onClick={handleStartPublishing}>
              {isAuthenticated ? "Go to Upload" : "Start Publishing"}
            </GlowButton>
            <Link href="/#content">
              <GlowButton variant="secondary" size="lg">
                Explore Works
              </GlowButton>
            </Link>
          </div>

          {/* Stats row — pulled from RegistryState PDA on-chain */}
          <div className="flex gap-8 mt-10 pt-10 border-t border-[#3D2F5A] text-center">
            {[
              { label: "Works Registered", value: stats.works > 0 ? String(stats.works) : "—" },
              { label: "Total Purchases",  value: stats.purchases > 0 ? String(stats.purchases) : "—" },
              { label: "SOL Volume",       value: parseFloat(stats.solVolume) > 0 ? `${stats.solVolume} SOL` : "—" },
            ].map((stat) => (
              <div key={stat.label} className="flex flex-col gap-1">
                <span className="text-2xl font-bold text-[#F7FF88]">{stat.value}</span>
                <span className="text-[#7A6E8E] text-sm">{stat.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
