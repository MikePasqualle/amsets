"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

interface ScrollRevealOptions {
  /** Delay before animation starts (seconds) */
  delay?: number;
  /** Animation duration (seconds) */
  duration?: number;
  /** Y offset to animate from */
  fromY?: number;
  /** Stagger when used on multiple children */
  stagger?: number;
  /** ScrollTrigger start position */
  start?: string;
}

/**
 * Reveals an element (or its children) as it enters the viewport.
 * Uses GSAP ScrollTrigger with opacity + translateY animation.
 *
 * @param options - Animation options
 * @returns ref to attach to the element or container
 */
export function useScrollReveal(options: ScrollRevealOptions = {}) {
  const {
    delay = 0,
    duration = 0.5,
    fromY = 40,
    stagger = 0,
    start = "top 85%",
  } = options;

  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Animate either the element itself or its direct children (for stagger)
    const targets = stagger > 0 ? Array.from(el.children) : [el];

    gsap.set(targets, { opacity: 0, y: fromY });

    const trigger = ScrollTrigger.create({
      trigger: el,
      start,
      onEnter: () => {
        gsap.to(targets, {
          opacity: 1,
          y: 0,
          duration,
          ease: "power2.out",
          delay,
          stagger,
        });
      },
      once: true,
    });

    return () => {
      trigger.kill();
    };
  }, [delay, duration, fromY, stagger, start]);

  return ref as React.RefObject<any>;
}
