import Link from "next/link";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PageTransition } from "@/components/layout/PageTransition";
import { HeroSection } from "@/components/content/HeroSection";
import { ContentCard } from "@/components/content/ContentCard";
import { PartnersSection } from "@/components/content/PartnersSection";
import { TeamSection } from "@/components/content/TeamSection";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getLatestContent() {
  try {
    const res = await fetch(`${API_URL}/api/v1/marketplace?page=1&limit=4`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.items ?? [];
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const latestItems = await getLatestContent();

  return (
    <>
      <Navbar />
      <PageTransition>
        <main className="min-h-screen">
          {/* Hero */}
          <HeroSection />

          {/* Latest 4 works */}
          <section className="max-w-7xl mx-auto px-6 pb-20">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-semibold text-[#EDE8F5]">Latest Works</h2>
                <p className="text-[#7A6E8E] text-sm mt-1">Most recently published content</p>
              </div>
              <Link
                href="/marketplace"
                className="inline-flex items-center gap-2 text-sm text-[#F7FF88] hover:text-[#EDE8F5] transition-colors font-medium"
              >
                View all
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </Link>
            </div>

            {latestItems.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                {latestItems.map((item: any) => (
                  <ContentCard key={item.contentId} {...item} />
                ))}
              </div>
            ) : (
              <div className="text-center py-20 text-[#7A6E8E]">
                <p className="text-lg">No published works yet.</p>
                <Link href="/upload" className="text-[#F7FF88] hover:underline mt-2 inline-block">
                  Be the first to publish →
                </Link>
              </div>
            )}

            {latestItems.length === 4 && (
              <div className="flex justify-center mt-10">
                <Link
                  href="/marketplace"
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-[#3D2F5A] text-[#EDE8F5] hover:border-[#F7FF88] hover:text-[#F7FF88] transition-all text-sm font-medium"
                >
                  Browse full marketplace →
                </Link>
              </div>
            )}
          </section>

          {/* Partners */}
          <PartnersSection />

          {/* Team */}
          <TeamSection />
        </main>
      </PageTransition>
      <Footer />
    </>
  );
}
