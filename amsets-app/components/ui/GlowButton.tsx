"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useRef } from "react";

interface GlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
}

/**
 * Branded CTA button with #F7FF88 glow effect and pulse animation.
 * Uses useGSAP for proper React lifecycle cleanup.
 */
export const GlowButton = forwardRef<HTMLButtonElement, GlowButtonProps>(
  ({ variant = "primary", size = "md", isLoading, children, className = "", ...props }, ref) => {
    const innerRef = useRef<HTMLButtonElement | null>(null);

    useGSAP(() => {
      const el = innerRef.current;
      if (!el || variant !== "primary") return;

      // Subtle pulse on box-shadow (draw attention to CTA)
      gsap.to(el, {
        boxShadow: "0 0 30px rgba(247, 255, 136, 0.5)",
        repeat: -1,
        yoyo: true,
        duration: 1.8,
        ease: "sine.inOut",
      });
    }, [variant]);

    const sizeClasses = {
      sm: "px-4 py-2 text-sm",
      md: "px-6 py-3 text-base",
      lg: "px-8 py-4 text-lg",
    }[size];

    const variantClasses = {
      primary:
        "bg-[#F7FF88] text-[#0D0A14] font-semibold hover:bg-[#eef077] active:scale-95",
      secondary:
        "bg-transparent border border-[#81D0B5] text-[#81D0B5] hover:bg-[#81D0B5]/10 active:scale-95",
      ghost:
        "bg-transparent text-[#EDE8F5] hover:text-[#F7FF88] active:scale-95",
    }[variant];

    const setRef = (el: HTMLButtonElement | null) => {
      innerRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = el;
    };

    return (
      <button
        ref={setRef}
        className={`
          inline-flex items-center justify-center gap-2
          rounded-lg font-medium
          transition-all duration-200
          disabled:opacity-50 disabled:cursor-not-allowed
          ${sizeClasses} ${variantClasses} ${className}
        `}
        disabled={isLoading || props.disabled}
        {...props}
      >
        {isLoading ? (
          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : null}
        {children}
      </button>
    );
  }
);

GlowButton.displayName = "GlowButton";
