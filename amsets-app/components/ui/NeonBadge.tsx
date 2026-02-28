import { ReactNode } from "react";

type BadgeVariant = "primary" | "secondary" | "muted";

interface NeonBadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

/**
 * Small badge component with neon border glow.
 * Primary: #F7FF88 glow. Secondary: #81D0B5 glow.
 */
export function NeonBadge({ children, variant = "secondary", className = "" }: NeonBadgeProps) {
  const styles = {
    primary: {
      border: "border-[#F7FF88]/50",
      text: "text-[#F7FF88]",
      bg: "bg-[#F7FF88]/10",
      shadow: "shadow-[0_0_8px_rgba(247,255,136,0.3)]",
    },
    secondary: {
      border: "border-[#81D0B5]/50",
      text: "text-[#81D0B5]",
      bg: "bg-[#81D0B5]/10",
      shadow: "shadow-[0_0_8px_rgba(129,208,181,0.3)]",
    },
    muted: {
      border: "border-[#3D2F5A]",
      text: "text-[#7A6E8E]",
      bg: "bg-[#221533]",
      shadow: "",
    },
  }[variant];

  return (
    <span
      className={`
        inline-flex items-center gap-1
        px-2.5 py-0.5
        rounded-full text-xs font-medium
        border
        ${styles.border} ${styles.text} ${styles.bg} ${styles.shadow}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
