"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import gsap from "gsap";
import { GlowButton } from "@/components/ui/GlowButton";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useAuth } from "@/lib/useAuth";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Screen = "main" | "email" | "phone";

/**
 * Authentication modal supporting:
 * - Email / Phone via Web3Auth (OTP, MPC wallet auto-created)
 * - Google / Apple via Web3Auth (OAuth, MPC wallet auto-created)
 * - Phantom / Solflare via Wallet Adapter
 *
 * Email and phone flows collect the address first, then pass it
 * as login_hint to Web3Auth so the OTP is sent to the right place.
 */
export function AuthModal({ isOpen, onClose }: AuthModalProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const { setVisible } = useWalletModal();
  const { loginWithWeb3Auth, isLoading, error } = useAuth();

  // Which sub-screen to show inside the modal
  const [screen, setScreen] = useState<Screen>("main");
  const [emailValue, setEmailValue] = useState("");
  const [phoneValue, setPhoneValue] = useState("");

  // Reset to main screen when modal opens
  useEffect(() => {
    if (isOpen) {
      setScreen("main");
      setEmailValue("");
      setPhoneValue("");
    }
  }, [isOpen]);

  // GSAP open/close animation
  useEffect(() => {
    const overlay = overlayRef.current;
    const modal = modalRef.current;
    if (!overlay || !modal) return;

    if (isOpen) {
      gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.out" });
      gsap.fromTo(
        modal,
        { opacity: 0, y: 24, scale: 0.96 },
        { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(1.5)" }
      );
    } else {
      gsap.to(modal, { opacity: 0, y: 16, duration: 0.2 });
      gsap.to(overlay, { opacity: 0, duration: 0.2 });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValue.trim()) return;
    // loginWithWeb3Auth returns { success } — close only on success
    const result = await loginWithWeb3Auth("email", emailValue.trim());
    if (result.success) onClose();
  }

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phoneValue.trim()) return;
    const result = await loginWithWeb3Auth("phone", phoneValue.trim());
    if (result.success) onClose();
  }

  async function handleSocial(provider: "google" | "apple") {
    const result = await loginWithWeb3Auth(provider);
    if (result.success) onClose();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      <div
        ref={modalRef}
        className="w-full max-w-sm bg-[#221533] border border-[#3D2F5A] rounded-2xl p-6 flex flex-col gap-5"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <Image src="/brand/logo-light.svg" alt="AMSETS" width={90} height={24} />
          <button
            onClick={onClose}
            className="text-[#7A6E8E] hover:text-[#EDE8F5] text-xl leading-none transition-colors"
          >
            ×
          </button>
        </div>

        {/* ── Main screen ──────────────────────────────────────────────────── */}
        {screen === "main" && (
          <>
            <div>
              <h2 className="text-[#EDE8F5] font-semibold text-lg">Sign in to AMSETS</h2>
              <p className="text-[#7A6E8E] text-sm mt-1">
                Create a wallet automatically or connect your existing one.
              </p>
            </div>

            {/* Social / Email login via Web3Auth */}
            <div className="flex flex-col gap-2">
              <p className="text-[#7A6E8E] text-xs font-medium uppercase tracking-wider">
                Create wallet with
              </p>

              <GlowButton
                variant="primary"
                size="md"
                onClick={() => setScreen("email")}
                className="w-full"
              >
                <MailIcon />
                Continue with Email
              </GlowButton>

              <GlowButton
                variant="secondary"
                size="md"
                onClick={() => setScreen("phone")}
                className="w-full"
              >
                <PhoneIcon />
                Continue with Phone
              </GlowButton>

              <div className="grid grid-cols-2 gap-2">
                <GlowButton
                  variant="ghost"
                  size="sm"
                  isLoading={isLoading}
                  onClick={() => handleSocial("google")}
                  className="w-full border border-[#3D2F5A]"
                >
                  Google
                </GlowButton>
                <GlowButton
                  variant="ghost"
                  size="sm"
                  isLoading={isLoading}
                  onClick={() => handleSocial("apple")}
                  className="w-full border border-[#3D2F5A]"
                >
                  Apple
                </GlowButton>
              </div>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-[#3D2F5A]" />
              <span className="text-[#7A6E8E] text-xs">or use existing wallet</span>
              <div className="flex-1 h-px bg-[#3D2F5A]" />
            </div>

            {/* Wallet Adapter */}
            <GlowButton
              variant="secondary"
              size="md"
              onClick={() => { setVisible(true); onClose(); }}
              className="w-full"
            >
              <WalletIcon />
              Connect Phantom / Solflare
            </GlowButton>

            {error && <p className="text-red-400 text-sm text-center">{error}</p>}

            <p className="text-[#7A6E8E] text-xs text-center">
              By connecting you agree to AMSETS Terms of Service.
            </p>
          </>
        )}

        {/* ── Email screen ─────────────────────────────────────────────────── */}
        {screen === "email" && (
          <>
            <div>
              <button
                onClick={() => setScreen("main")}
                className="text-[#7A6E8E] text-sm hover:text-[#EDE8F5] transition-colors mb-3 flex items-center gap-1"
              >
                ← Back
              </button>
              <h2 className="text-[#EDE8F5] font-semibold text-lg">Enter your email</h2>
              <p className="text-[#7A6E8E] text-sm mt-1">
                We'll send a one-time code to verify your identity.
                A Solana wallet will be created automatically.
              </p>
            </div>

            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-3">
              <input
                type="email"
                value={emailValue}
                onChange={(e) => setEmailValue(e.target.value)}
                placeholder="you@example.com"
                autoFocus
                required
                className="w-full bg-[#120D1E] border border-[#3D2F5A] rounded-xl px-4 py-3 text-[#EDE8F5] placeholder-[#7A6E8E] text-sm outline-none focus:border-[#F7FF88]/60 transition-colors"
              />

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <GlowButton
                variant="primary"
                size="md"
                isLoading={isLoading}
                className="w-full"
              >
                Send Code →
              </GlowButton>
            </form>
          </>
        )}

        {/* ── Phone screen ─────────────────────────────────────────────────── */}
        {screen === "phone" && (
          <>
            <div>
              <button
                onClick={() => setScreen("main")}
                className="text-[#7A6E8E] text-sm hover:text-[#EDE8F5] transition-colors mb-3 flex items-center gap-1"
              >
                ← Back
              </button>
              <h2 className="text-[#EDE8F5] font-semibold text-lg">Enter your phone</h2>
              <p className="text-[#7A6E8E] text-sm mt-1">
                Include country code, e.g. +380671234567.
                A Solana wallet will be created automatically.
              </p>
            </div>

            <form onSubmit={handlePhoneSubmit} className="flex flex-col gap-3">
              <input
                type="tel"
                value={phoneValue}
                onChange={(e) => setPhoneValue(e.target.value)}
                placeholder="+380671234567"
                autoFocus
                required
                className="w-full bg-[#120D1E] border border-[#3D2F5A] rounded-xl px-4 py-3 text-[#EDE8F5] placeholder-[#7A6E8E] text-sm outline-none focus:border-[#F7FF88]/60 transition-colors"
              />

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <GlowButton
                variant="primary"
                size="md"
                isLoading={isLoading}
                className="w-full"
              >
                Send SMS →
              </GlowButton>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Inline SVG icons ────────────────────────────────────────────────────────

function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 01-2.06 0L2 7" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M12 18h.01" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4" />
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4" />
      <path d="M18 12a2 2 0 000 4h4v-4h-4z" />
    </svg>
  );
}
