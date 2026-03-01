import Image from "next/image";
import Link from "next/link";

const PRODUCT_LINKS = [
  { label: "Marketplace",  href: "/marketplace" },
  { label: "Publish",      href: "/upload" },
  { label: "My Library",   href: "/my/library" },
  { label: "My Works",     href: "/my/content" },
];

const RESOURCES_LINKS = [
  { label: "Whitepaper", href: "/whitepaper" },
];

const COMMUNITY_LINKS = [
  { label: "X / Twitter",  href: "https://x.com/amsets_space", external: true },
  { label: "GitHub",       href: "https://github.com/amsets-space", external: true },
  { label: "Discord",      href: "https://discord.gg/amsets", external: true },
];

export function Footer() {
  return (
    <footer className="border-t border-[#3D2F5A] mt-24 py-16 px-6">
      <div className="max-w-7xl mx-auto">
        {/* Top row: brand + columns */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          {/* Brand */}
          <div className="md:col-span-1 flex flex-col gap-4">
            <Image
              src="/brand/logo-light.svg"
              alt="AMSETS"
              width={110}
              height={30}
            />
            <p className="text-[#7A6E8E] text-sm leading-relaxed max-w-xs">
              Decentralized IP rights ledger on Solana. Register, protect, and
              monetize your creative work — without intermediaries.
            </p>
            {/* Social icons */}
            <div className="flex items-center gap-3 mt-1">
              <a
                href="https://x.com/amsets_space"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="X / Twitter"
                className="w-8 h-8 rounded-lg bg-[#221533] border border-[#3D2F5A] flex items-center justify-center text-[#7A6E8E] hover:text-[#EDE8F5] hover:border-[#F7FF88]/30 transition-all duration-200"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63Zm-1.161 17.52h1.833L7.084 4.126H5.117Z" />
                </svg>
              </a>
              <a
                href="https://github.com/amsets-space"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="w-8 h-8 rounded-lg bg-[#221533] border border-[#3D2F5A] flex items-center justify-center text-[#7A6E8E] hover:text-[#EDE8F5] hover:border-[#F7FF88]/30 transition-all duration-200"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
              </a>
              <a
                href="https://discord.gg/amsets"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Discord"
                className="w-8 h-8 rounded-lg bg-[#221533] border border-[#3D2F5A] flex items-center justify-center text-[#7A6E8E] hover:text-[#EDE8F5] hover:border-[#F7FF88]/30 transition-all duration-200"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
            </div>
          </div>

          {/* Product */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[#EDE8F5] text-xs font-semibold uppercase tracking-widest mb-1">
              Product
            </h4>
            {PRODUCT_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[#7A6E8E] hover:text-[#EDE8F5] text-sm transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Resources */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[#EDE8F5] text-xs font-semibold uppercase tracking-widest mb-1">
              Resources
            </h4>
            {RESOURCES_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-[#7A6E8E] hover:text-[#EDE8F5] text-sm transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Community */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[#EDE8F5] text-xs font-semibold uppercase tracking-widest mb-1">
              Community
            </h4>
            {COMMUNITY_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#7A6E8E] hover:text-[#EDE8F5] text-sm transition-colors inline-flex items-center gap-1"
              >
                {link.label}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-50">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
            ))}
          </div>
        </div>

        {/* Bottom row: copyright + blockchain badge */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-8 border-t border-[#3D2F5A]">
          <p className="text-[#7A6E8E] text-xs">
            © {new Date().getFullYear()} AMSETS. All rights reserved.
          </p>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium bg-[#221533] border border-[#3D2F5A] text-[#7A6E8E]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#81D0B5] animate-pulse" />
              Powered by Solana Devnet
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
