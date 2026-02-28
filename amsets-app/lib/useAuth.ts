"use client";

import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface AuthUser {
  id: string;
  walletAddress: string;
  username: string | null;
  avatarUrl: string | null;
  isOnChainAccountOpened: boolean;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Build the auth message to sign.
 * Includes wallet address and timestamp for replay protection.
 */
function buildAuthMessage(walletAddress: string, timestamp: number): string {
  return `AMSETS auth: ${walletAddress} at ${timestamp}`;
}

/**
 * Core hook for AMSETS authentication.
 * Handles both Wallet Adapter (Phantom/Solflare) and Web3Auth (email/phone/Google).
 */
export function useAuth() {
  const { publicKey, signMessage, connected } = useWallet();
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    isLoading: false,
    error: null,
  });

  /**
   * Authenticate using any connected wallet (Phantom, Solflare, Web3Auth).
   * Signs a message then sends to backend for Ed25519 verification.
   */
  const loginWithWallet = useCallback(
    async (authMethod = "wallet_adapter") => {
      if (!publicKey || !signMessage) {
        setState((s) => ({ ...s, error: "No wallet connected" }));
        return;
      }

      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        const timestamp = Date.now();
        const message = buildAuthMessage(publicKey.toBase58(), timestamp);
        const messageBytes = new TextEncoder().encode(message);

        const signatureBytes = await signMessage(messageBytes);
        const signature = bs58.encode(signatureBytes);

        const response = await fetch(`${API_URL}/api/v1/auth/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_address: publicKey.toBase58(),
            signed_message: signature,
            timestamp,
            auth_method: authMethod,
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error ?? "Authentication failed");
        }

        const data = (await response.json()) as { token: string; user: AuthUser };

        // Persist token in localStorage
        localStorage.setItem("amsets_token", data.token);

        setState({
          user: data.user,
          token: data.token,
          isLoading: false,
          error: null,
        });
      } catch (err: any) {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: err.message ?? "Authentication failed",
        }));
      }
    },
    [publicKey, signMessage]
  );

  /**
   * Login via Web3Auth email/phone/social.
   * Web3Auth creates an MPC Solana wallet under the hood.
   *
   * @param provider   - "email" | "phone" | "google" | "apple"
   * @param loginHint  - For email: the email address. For phone: "+380...".
   *                     Required for passwordless; OAuth providers don't need it.
   * @returns { success: boolean } — so the caller (AuthModal) can close on success.
   */
  const loginWithWeb3Auth = useCallback(
    async (
      provider: "email" | "phone" | "google" | "apple",
      loginHint?: string
    ): Promise<{ success: boolean }> => {
      setState((s) => ({ ...s, isLoading: true, error: null }));

      try {
        const { Web3Auth } = await import("@web3auth/modal");
        const { SolanaPrivateKeyProvider } = await import("@web3auth/solana-provider");
        const { WALLET_ADAPTERS } = await import("@web3auth/base");

        const chainConfig = {
          chainNamespace: "solana" as const,
          chainId: "0x3", // devnet
          rpcTarget:
            process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
          displayName: "Solana Devnet",
          ticker: "SOL",
          tickerName: "Solana",
        };

        const privateKeyProvider = new SolanaPrivateKeyProvider({
          config: { chainConfig },
        });

        const web3auth = new Web3Auth({
          clientId: process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID ?? "",
          web3AuthNetwork: "sapphire_devnet",
          privateKeyProvider,
        });

        // initModal() may restore an existing session — check before connectTo()
        await web3auth.initModal();

        if (!web3auth.connected) {
          // Map provider → Web3Auth loginProvider string
          const loginProvider =
            provider === "email"  ? "email_passwordless"
            : provider === "phone" ? "sms_passwordless"
            : provider; // "google" | "apple"

          // Passwordless requires login_hint (email or phone number).
          // OAuth providers (google/apple) open their own popup — no hint needed.
          await web3auth.connectTo(WALLET_ADAPTERS.AUTH, {
            loginProvider,
            ...(loginHint ? { extraLoginOptions: { login_hint: loginHint } } : {}),
          });
        }

        const solanaProvider = web3auth.provider;
        if (!solanaProvider) throw new Error("No provider after Web3Auth login");

        // Get the Solana address from the Web3Auth MPC wallet
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accounts = (await (solanaProvider as any).request({
          method: "getAccounts",
        })) as string[];
        const walletAddress = accounts?.[0];
        if (!walletAddress) throw new Error("Could not retrieve wallet address");

        // Sign a challenge to authenticate with the AMSETS backend
        const timestamp = Date.now();
        const message = `AMSETS auth: ${walletAddress} at ${timestamp}`;
        const messageBytes = new TextEncoder().encode(message);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const signatureResult = (await (solanaProvider as any).request({
          method: "signMessage",
          params: { message: messageBytes, display: "utf8" },
        }));

        // Web3Auth Solana provider can return several formats depending on version:
        // - Uint8Array directly
        // - number[]
        // - { signature: Uint8Array | number[] }
        const { default: bs58enc } = await import("bs58");
        let signatureBytes: Uint8Array;
        if (signatureResult instanceof Uint8Array) {
          signatureBytes = signatureResult;
        } else if (Array.isArray(signatureResult)) {
          signatureBytes = new Uint8Array(signatureResult as number[]);
        } else if (signatureResult?.signature) {
          const sig = signatureResult.signature;
          signatureBytes = sig instanceof Uint8Array ? sig : new Uint8Array(sig as number[]);
        } else {
          throw new Error("Unexpected signMessage response from Web3Auth provider");
        }
        const signature = bs58enc.encode(signatureBytes);

        // Map UI provider to the backend enum value
        const authMethod =
          provider === "email"  ? "web3auth_email"
          : provider === "phone" ? "web3auth_phone"
          : provider === "google" ? "web3auth_google"
          : "web3auth_apple";

        const response = await fetch(`${API_URL}/api/v1/auth/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet_address: walletAddress,
            signed_message: signature,
            timestamp,
            auth_method: authMethod, // matches backend Zod enum exactly
          }),
        });

        if (!response.ok) {
          const body = await response.json();
          // body.error can be a Zod error object or a plain string
          const errMsg =
            typeof body.error === "string"
              ? body.error
              : body.message ?? JSON.stringify(body.error) ?? "Authentication failed";
          throw new Error(errMsg);
        }

        const data = (await response.json()) as { token: string; user: AuthUser };

        // Persist session — both token (for API calls) and address (for UI)
        localStorage.setItem("amsets_token", data.token);
        localStorage.setItem("amsets_wallet", walletAddress);

        // Store the Web3Auth Solana provider globally so UploadSteps can use it
        // as the Irys wallet provider for Arweave uploads.
        // The provider implements signTransaction / publicKey — same interface as window.solana.
        if (typeof window !== "undefined") {
          (window as any).__amsets_web3auth_provider = solanaProvider;
        }

        // Notify all components (same tab) that a Web3Auth session is now active
        window.dispatchEvent(new Event("amsets_session_changed"));

        setState({ user: data.user, token: data.token, isLoading: false, error: null });
        return { success: true };
      } catch (err: any) {
        // Ensure error is always a human-readable string, never "[object Object]"
        const raw = err?.message ?? err;
        const message =
          typeof raw === "string" && raw
            ? raw
            : "Login failed. Please try again.";
        setState((s) => ({ ...s, isLoading: false, error: message }));
        return { success: false };
      }
    },
    []
  );

  const logout = useCallback(() => {
    localStorage.removeItem("amsets_token");
    localStorage.removeItem("amsets_wallet");
    if (typeof window !== "undefined") {
      delete (window as any).__amsets_web3auth_provider;
    }
    window.dispatchEvent(new Event("amsets_session_changed"));
    setState({ user: null, token: null, isLoading: false, error: null });
  }, []);

  const restoreSession = useCallback(() => {
    const token = localStorage.getItem("amsets_token");
    if (token) {
      // TODO: verify token expiry and fetch user profile
      setState((s) => ({ ...s, token }));
    }
  }, []);

  return {
    ...state,
    isConnected: connected,
    walletAddress: publicKey?.toBase58() ?? null,
    loginWithWallet,
    loginWithWeb3Auth,
    logout,
    restoreSession,
  };
}
