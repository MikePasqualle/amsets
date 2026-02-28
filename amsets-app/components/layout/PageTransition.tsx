"use client";

import { ReactNode, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import gsap from "gsap";

interface Props {
  children: ReactNode;
}

/**
 * Wraps page content with enter/exit transitions.
 * Enter: opacity 0→1, y 20→0, duration 0.4s, power2.out
 * Exit:  handled by Next.js route change (instant)
 *
 * In Next.js 14 App Router, exit animations require a more
 * complex setup with AnimatePresence-like state management.
 * Here we implement a simple enter animation triggered on route change.
 */
export function PageTransition({ children }: Props) {
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Animate in on route change
    gsap.fromTo(
      el,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }
    );
  }, [pathname]);

  return (
    <div ref={containerRef} className="will-animate">
      {children}
    </div>
  );
}
