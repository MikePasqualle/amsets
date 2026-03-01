import { Suspense } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PageTransition } from "@/components/layout/PageTransition";
import { MarketplaceClient } from "@/components/content/MarketplaceClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function getInitialMarketplace(category?: string, search?: string) {
  try {
    const params = new URLSearchParams({ page: "1", limit: "20" });
    if (category) params.set("category", category);
    if (search) params.set("search", search);

    const res = await fetch(`${API_URL}/api/v1/marketplace?${params}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return { items: [], total: 0 };
    const data = await res.json();
    return { items: data.items ?? [], total: data.total ?? data.items?.length ?? 0 };
  } catch {
    return { items: [], total: 0 };
  }
}

interface PageProps {
  searchParams: Promise<{ category?: string; search?: string; q?: string }>;
}

export default async function MarketplacePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const category = params.category;
  const search = params.search ?? params.q;

  const { items, total } = await getInitialMarketplace(category, search);

  return (
    <>
      <Navbar />
      <PageTransition>
        <main className="min-h-screen pt-24 pb-16">
          <div className="max-w-7xl mx-auto px-6">
            {/* Header */}
            <div className="mb-10">
              <h1 className="text-4xl font-bold text-[#EDE8F5] mb-2">Marketplace</h1>
              <p className="text-[#7A6E8E]">
                Discover and collect digital works with on-chain ownership
              </p>
            </div>

            <Suspense fallback={<MarketplaceSkeleton />}>
              <MarketplaceClient
                initialItems={items}
                initialCategory={category}
                initialSearch={search}
              />
            </Suspense>
          </div>
        </main>
      </PageTransition>
      <Footer />
    </>
  );
}

function MarketplaceSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 mt-8">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="animate-pulse bg-[#221533] rounded-xl aspect-[3/4]" />
      ))}
    </div>
  );
}
