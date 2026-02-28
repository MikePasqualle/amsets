"use client";

import Image from "next/image";
import { useScrollReveal } from "@/components/animations/useScrollReveal";

interface TeamMember {
  name: string;
  role: string;
  bio: string;
  avatar: string;
  twitter?: string;
  linkedin?: string;
}

const TEAM: TeamMember[] = [
  {
    name: "Michael Patsan",
    role: "Founder & CEO",
    bio: "Entrepreneur and product strategist focused on bridging Web2 user experience with decentralized ownership models. Leads product vision, partnerships, and go-to-market for AMSETS.",
    avatar: "/team/michael.png",
    twitter: "https://x.com/amsets_space",
  },
  {
    name: "Artem Atepalikhin",
    role: "Founder",
    bio: "Full-stack engineer with deep expertise in distributed systems, cryptography, and Solana smart contracts. Architected the AMSETS smart contract, Lit Protocol integration, and decentralized storage pipeline.",
    avatar: "/team/artem.png",
  },
];

/**
 * Team section displayed on the homepage.
 * Shows founder cards with generated cartoon avatars, name, role, and bio.
 */
export function TeamSection() {
  const sectionRef = useScrollReveal({ stagger: 0.15, fromY: 30 });

  return (
    <section className="max-w-7xl mx-auto px-6 py-20">
      {/* Section heading */}
      <div className="flex flex-col items-center text-center mb-14">
        <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold bg-[#81D0B5]/10 text-[#81D0B5] border border-[#81D0B5]/30 mb-4">
          Team
        </span>
        <h2 className="text-3xl md:text-4xl font-bold text-[#EDE8F5] mb-3">
          Built by founders who care
        </h2>
        <p className="text-[#7A6E8E] text-base max-w-lg">
          AMSETS is created by a small, focused team that believes creators deserve
          ownership — not just a platform.
        </p>
      </div>

      {/* Member cards */}
      <div
        ref={sectionRef}
        className="grid grid-cols-1 sm:grid-cols-2 gap-8 max-w-3xl mx-auto"
      >
        {TEAM.map((member) => (
          <article
            key={member.name}
            className="group flex flex-col items-center text-center gap-5 p-8 rounded-2xl bg-[#221533] border border-[#3D2F5A] hover:border-[#F7FF88]/30 transition-all duration-300 hover:shadow-[0_0_32px_rgba(247,255,136,0.08)]"
          >
            {/* Avatar */}
            <div className="relative w-28 h-28 rounded-full overflow-hidden ring-2 ring-[#3D2F5A] group-hover:ring-[#F7FF88]/40 transition-all duration-300">
              <Image
                src={member.avatar}
                alt={member.name}
                fill
                className="object-cover"
                unoptimized
              />
            </div>

            {/* Info */}
            <div className="flex flex-col gap-2">
              <h3 className="text-[#EDE8F5] font-bold text-lg leading-tight">
                {member.name}
              </h3>
              <span className="inline-flex items-center self-center rounded-full px-3 py-0.5 text-xs font-semibold bg-[#F7FF88]/10 text-[#F7FF88] border border-[#F7FF88]/20">
                {member.role}
              </span>
              <p className="text-[#7A6E8E] text-sm leading-relaxed mt-1">
                {member.bio}
              </p>
            </div>

            {/* Social links */}
            {member.twitter && (
              <a
                href={member.twitter}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-[#7A6E8E] hover:text-[#81D0B5] transition-colors"
                aria-label={`${member.name} on X`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63Zm-1.161 17.52h1.833L7.084 4.126H5.117Z" />
                </svg>
                @amsets_space
              </a>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
