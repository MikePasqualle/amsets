"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

/**
 * Stagger letter-by-letter reveal animation for the AMSETS logo/title.
 * Each letter slides up from y:100% → y:0 with opacity fade.
 *
 * @param text - The text to animate letter-by-letter
 * @returns ref to attach to the container element
 */
export function useLogoReveal(text: string) {
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Wrap each character in a span for individual animation
    const chars = text.split("").map((char) => {
      const span = document.createElement("span");
      span.textContent = char === " " ? "\u00A0" : char;
      span.style.display = "inline-block";
      span.style.overflow = "hidden";
      return span;
    });

    el.innerHTML = "";
    chars.forEach((s) => el.appendChild(s));

    // Set initial state
    gsap.set(chars, { y: "100%", opacity: 0 });

    // Stagger animate in
    const tl = gsap.timeline({ delay: 0.1 });
    tl.to(chars, {
      y: 0,
      opacity: 1,
      duration: 0.6,
      ease: "power3.out",
      stagger: 0.04,
    });

    return () => {
      tl.kill();
    };
  }, [text]);

  return containerRef;
}
