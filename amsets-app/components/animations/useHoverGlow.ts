"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

/**
 * Adds a glow scale effect on mouse enter/leave.
 * Used on ContentCard and GlowButton components.
 *
 * @param glowColor - CSS color string for the box-shadow glow
 */
export function useHoverGlow(glowColor = "rgba(247, 255, 136, 0.3)") {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onEnter = () => {
      gsap.to(el, {
        scale: 1.02,
        boxShadow: `0 0 24px ${glowColor}`,
        duration: 0.25,
        ease: "power2.out",
      });
    };

    const onLeave = () => {
      gsap.to(el, {
        scale: 1,
        boxShadow: "0 0 0px transparent",
        duration: 0.3,
        ease: "power2.inOut",
      });
    };

    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);

    return () => {
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [glowColor]);

  return ref as React.RefObject<any>;
}
