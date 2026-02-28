"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { AuthModal } from "@/components/auth/AuthModal";

interface AuthModalContextType {
  /** Opens the authentication modal */
  openAuth: () => void;
  /** Closes the authentication modal */
  closeAuth: () => void;
  /** Whether the modal is currently open */
  authOpen: boolean;
}

const AuthModalContext = createContext<AuthModalContextType>({
  openAuth: () => {},
  closeAuth: () => {},
  authOpen: false,
});

/**
 * Provides a single, global authentication modal.
 * Any component can call openAuth() — there is only ONE AuthModal in the DOM.
 * This prevents state desync between Navbar, HeroSection, LibraryClient, etc.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [authOpen, setAuthOpen] = useState(false);

  const openAuth = useCallback(() => setAuthOpen(true), []);
  const closeAuth = useCallback(() => setAuthOpen(false), []);

  return (
    <AuthModalContext.Provider value={{ openAuth, closeAuth, authOpen }}>
      {children}
      {/* Single AuthModal instance for the entire app */}
      <AuthModal isOpen={authOpen} onClose={closeAuth} />
    </AuthModalContext.Provider>
  );
}

/** Hook to open/close the auth modal from any component */
export function useAuthModal() {
  return useContext(AuthModalContext);
}
