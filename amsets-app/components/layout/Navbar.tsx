"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useWallet } from "@solana/wallet-adapter-react";
import { GlowButton } from "@/components/ui/GlowButton";
import { useAuthModal } from "@/providers/AuthContext";
import { useAuth } from "@/lib/useAuth";

gsap.registerPlugin(ScrollTrigger);

/**
 * Sticky navbar that shrinks and gains a frosted-glass background on scroll.
 * Renders an AuthModal when the Connect button is clicked.
 */
export function Navbar() {
  const navRef = useRef<HTMLElement | null>(null);
  const { openAuth } = useAuthModal();

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const trigger = ScrollTrigger.create({
      start: "top+=50 top",
      onEnter: () => {
        gsap.to(nav, {
          height: 56,
          backdropFilter: "blur(12px)",
          backgroundColor: "rgba(13, 10, 20, 0.9)",
          duration: 0.3,
          ease: "power2.out",
        });
      },
      onLeaveBack: () => {
        gsap.to(nav, {
          height: 72,
          backdropFilter: "blur(0px)",
          backgroundColor: "rgba(13, 10, 20, 0)",
          duration: 0.3,
          ease: "power2.inOut",
        });
      },
    });

    return () => {
      trigger.kill();
    };
  }, []);

  return (
    <>
      <nav
        ref={navRef}
        className="fixed top-0 left-0 right-0 z-40 flex items-center px-6"
        style={{ height: 72, willChange: "height, background-color" }}
      >
        <div className="max-w-7xl mx-auto w-full flex items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/brand/logo-light.svg"
              alt="AMSETS"
              width={120}
              height={32}
              style={{ height: "32px", width: "auto" }}
              priority
            />
          </Link>

          {/* Navigation links */}
          <div className="hidden md:flex items-center gap-8">
            <Link
              href="/marketplace"
              className="text-[#EDE8F5]/70 hover:text-[#F7FF88] text-sm font-medium transition-colors"
            >
              Marketplace
            </Link>
            <Link
              href="/upload"
              className="text-[#EDE8F5]/70 hover:text-[#F7FF88] text-sm font-medium transition-colors"
            >
              Publish
            </Link>
            <Link
              href="/my/library"
              className="text-[#EDE8F5]/70 hover:text-[#F7FF88] text-sm font-medium transition-colors"
            >
              Library
            </Link>
            <Link
              href="/my/content"
              className="text-[#EDE8F5]/70 hover:text-[#F7FF88] text-sm font-medium transition-colors"
            >
              My Works
            </Link>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Link href="/upload">
              <GlowButton variant="primary" size="sm">
                + Publish
              </GlowButton>
            </Link>
            <ConnectButton onOpenAuth={openAuth} />
          </div>
        </div>
      </nav>
    </>
  );
}

// ─── Connect / Wallet button ──────────────────────────────────────────────────

interface ConnectButtonProps {
  onOpenAuth: () => void;
}

function ConnectButton({ onOpenAuth }: ConnectButtonProps) {
  const { publicKey, connected, disconnect } = useWallet();
  const { loginWithWallet } = useAuth();
  const [mounted, setMounted] = useState(false);
  const [isAutoAuthing, setIsAutoAuthing] = useState(false);
  // Address from Web3Auth session (stored in localStorage after email/phone/social login)
  const [web3authAddress, setWeb3authAddress] = useState<string | null>(null);
  const hasAutoAuthed = useRef(false);

  useEffect(() => {
    setMounted(true);

    const syncSession = () => {
      setWeb3authAddress(localStorage.getItem("amsets_wallet"));
    };

    syncSession(); // read on mount

    // Listen for same-tab login/logout events dispatched by useAuth
    window.addEventListener("amsets_session_changed", syncSession);
    return () => window.removeEventListener("amsets_session_changed", syncSession);
  }, []);

  // Auto-authenticate with AMSETS backend when Phantom/Solflare connects.
  // This prompts the user to sign a message so the backend can issue a JWT.
  // Without this step, uploads and registrations fail with 401.
  useEffect(() => {
    if (!connected || !publicKey) {
      hasAutoAuthed.current = false;
      return;
    }
    if (hasAutoAuthed.current) return;
    hasAutoAuthed.current = true;

    // Skip re-auth only if the stored token is still valid (not expired)
    const storedToken = localStorage.getItem("amsets_token");
    if (storedToken) {
      try {
        const payload = JSON.parse(atob(storedToken.split(".")[1]));
        const expiredAt = (payload.exp ?? 0) * 1000;
        if (Date.now() < expiredAt) return; // token is still valid
      } catch {
        // Malformed token — clear it and re-auth
      }
      localStorage.removeItem("amsets_token");
      window.dispatchEvent(new Event("amsets_session_changed"));
    }

    // Brief delay to ensure the wallet connection is fully established before signing
    const timer = setTimeout(async () => {
      setIsAutoAuthing(true);
      try {
        await loginWithWallet("wallet_adapter");
      } finally {
        setIsAutoAuthing(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [connected, publicKey, loginWithWallet]);

  function handleDisconnectAll() {
    // Disconnect Wallet Adapter session
    if (connected) disconnect();
    // Clear Web3Auth session from localStorage
    localStorage.removeItem("amsets_token");
    localStorage.removeItem("amsets_wallet");
    window.dispatchEvent(new Event("amsets_session_changed"));
  }

  if (!mounted) {
    return (
      <GlowButton variant="secondary" size="sm" onClick={onOpenAuth}>
        Connect
      </GlowButton>
    );
  }

  // Wallet Adapter connection (Phantom / Solflare)
  if (connected && publicKey) {
    const address = publicKey.toBase58();
    if (isAutoAuthing) {
      return (
        <span className="text-[#F7FF88] text-xs px-3 py-1.5 border border-[#F7FF88]/40 rounded-lg animate-pulse">
          Signing in…
        </span>
      );
    }
    return (
      <button
        onClick={handleDisconnectAll}
        title="Click to disconnect"
        className="text-[#81D0B5] text-sm font-mono px-3 py-1.5 border border-[#81D0B5]/40 rounded-lg hover:border-red-400/60 hover:text-red-400 transition-colors"
      >
        {address.slice(0, 4)}…{address.slice(-4)}
      </button>
    );
  }

  // Web3Auth session (email / phone / social)
  if (web3authAddress) {
    return (
      <button
        onClick={handleDisconnectAll}
        title="Click to disconnect"
        className="text-[#81D0B5] text-sm font-mono px-3 py-1.5 border border-[#81D0B5]/40 rounded-lg hover:border-red-400/60 hover:text-red-400 transition-colors"
      >
        {web3authAddress.slice(0, 4)}…{web3authAddress.slice(-4)}
      </button>
    );
  }

  return (
    <GlowButton variant="secondary" size="sm" onClick={onOpenAuth}>
      Connect
    </GlowButton>
  );
}
