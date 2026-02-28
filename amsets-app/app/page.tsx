import { Suspense } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PageTransition } from "@/components/layout/PageTransition";
import { HeroSection } from "@/components/content/HeroSection";
import { ContentGrid } from "@/components/content/ContentGrid";
import { PartnersSection } from "@/components/content/PartnersSection";
import { TeamSection } from "@/components/content/TeamSection";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getInitialContent() {
  try {
    const res = await fetch(`${API_URL}/api/v1/marketplace?page=1&limit=20`, {
      // No cache — show new content (including drafts) immediately after upload
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.items ?? [];
  } catch {
    return [];
  }
}

export default async function MarketplacePage() {
  const initialItems = await getInitialContent();

  return (
    <>
      <Navbar />
      <PageTransition>
        <main className="min-h-screen">
          {/* Hero section with GSAP letter reveal */}
          <HeroSection />

          {/* Content grid */}
          <section className="max-w-7xl mx-auto px-6 pb-16">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-semibold text-[#EDE8F5]">
                Latest Works
              </h2>
              <span className="text-[#7A6E8E] text-sm">
                {initialItems.length > 0 ? `${initialItems.length}+ items` : "No items yet"}
              </span>
            </div>

            <Suspense fallback={<GridSkeleton />}>
              <ContentGrid initialItems={initialItems} />
            </Suspense>
          </section>

          {/* Protocol partners */}
          <PartnersSection />

          {/* Team */}
          <TeamSection />
        </main>
      </PageTransition>
      <Footer />
    </>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="card-surface animate-pulse aspect-[3/4] rounded-xl"
        />
      ))}
    </div>
  );
}
