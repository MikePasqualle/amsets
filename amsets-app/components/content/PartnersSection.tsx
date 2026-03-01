"use client";

import { useScrollReveal } from "@/components/animations/useScrollReveal";

interface Partner {
  name: string;
  role: string;
  url: string;
  /** Inline SVG path data or a simple icon character */
  icon: React.ReactNode;
  accent: string;
}

const PARTNERS: Partner[] = [
  {
    name: "Solana",
    role: "Layer 1 Blockchain",
    url: "https://solana.com",
    accent: "#9945FF",
    icon: (
      <svg width="24" height="24" viewBox="0 0 397.7 311.7" fill="currentColor">
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z"/>
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1L333.1 73.8c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z"/>
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"/>
      </svg>
    ),
  },
  {
    name: "Livepeer",
    role: "Decentralized Video Network",
    url: "https://livepeer.studio",
    accent: "#00EB88",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>
      </svg>
    ),
  },
  {
    name: "Helius",
    role: "Solana RPC + DAS Indexer",
    url: "https://helius.dev",
    accent: "#F7FF88",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
  },
  {
    name: "Web3Auth",
    role: "Social & Email Wallet",
    url: "https://web3auth.io",
    accent: "#81D0B5",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    ),
  },
  {
    name: "IPFS",
    role: "Preview & Metadata CDN",
    url: "https://ipfs.tech",
    accent: "#81D0B5",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 2 7 12 12 22 7 12 2"/>
        <polyline points="2 17 12 22 22 17"/>
        <polyline points="2 12 12 17 22 12"/>
      </svg>
    ),
  },
  {
    name: "Neon",
    role: "Serverless PostgreSQL",
    url: "https://neon.tech",
    accent: "#00EB88",
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3"/>
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
      </svg>
    ),
  },
];

/**
 * Partners section — showcases the decentralized protocol stack powering AMSETS.
 */
export function PartnersSection() {
  const sectionRef = useScrollReveal({ stagger: 0.06, fromY: 20 });

  return (
    <section className="max-w-7xl mx-auto px-6 py-20 border-t border-[#3D2F5A]">
      {/* Section heading */}
      <div className="flex flex-col items-center text-center mb-12">
        <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold bg-[#F7FF88]/10 text-[#F7FF88] border border-[#F7FF88]/30 mb-4">
          Powered By
        </span>
        <h2 className="text-3xl md:text-4xl font-bold text-[#EDE8F5] mb-3">
          The decentralized stack
        </h2>
        <p className="text-[#7A6E8E] text-base max-w-lg">
          AMSETS integrates best-in-class Web3 protocols so no single point of failure
          can compromise your content or ownership rights.
        </p>
      </div>

      {/* Partner grid */}
      <div
        ref={sectionRef}
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4"
      >
        {PARTNERS.map((partner) => (
          <a
            key={partner.name}
            href={partner.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col items-center text-center gap-3 p-6 rounded-2xl bg-[#221533] border border-[#3D2F5A] hover:border-[#3D2F5A]/80 hover:bg-[#2D1F47] transition-all duration-300"
            style={{ "--partner-accent": partner.accent } as React.CSSProperties}
          >
            {/* Icon */}
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-300"
              style={{ color: partner.accent, background: `${partner.accent}15` }}
            >
              {partner.icon}
            </div>

            {/* Name + role */}
            <div>
              <p
                className="font-semibold text-sm transition-colors duration-200 group-hover:opacity-90"
                style={{ color: partner.accent }}
              >
                {partner.name}
              </p>
              <p className="text-[#7A6E8E] text-xs mt-0.5 leading-snug">
                {partner.role}
              </p>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
