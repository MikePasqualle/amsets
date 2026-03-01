"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ContentCard } from "./ContentCard";

gsap.registerPlugin(ScrollTrigger);

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const CATEGORIES = [
  { value: "", label: "All" },
  { value: "art", label: "Art" },
  { value: "music", label: "Music" },
  { value: "video", label: "Video" },
  { value: "education", label: "Education" },
  { value: "gaming", label: "Gaming" },
  { value: "general", label: "General" },
];

interface ContentItem {
  contentId: string;
  title: string;
  description?: string;
  previewUri: string;
  authorWallet: string;
  basePrice: string;
  paymentToken: "SOL" | "USDC";
  license: string;
  category?: string;
  status?: string;
}

interface MarketplaceClientProps {
  initialItems: ContentItem[];
  initialCategory?: string;
  initialSearch?: string;
}

export function MarketplaceClient({
  initialItems,
  initialCategory,
  initialSearch,
}: MarketplaceClientProps) {
  const router = useRouter();
  const pathname = usePathname();

  const [items, setItems]             = useState<ContentItem[]>(initialItems);
  const [category, setCategory]       = useState(initialCategory ?? "");
  const [search, setSearch]           = useState(initialSearch ?? "");
  const [searchInput, setSearchInput] = useState(initialSearch ?? "");
  const [page, setPage]               = useState(1);
  const [hasMore, setHasMore]         = useState(initialItems.length === 20);
  const [isLoading, setIsLoading]     = useState(false);
  const [isFetching, setIsFetching]   = useState(false);

  const gridRef  = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);

  // Animate new cards
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || items.length === 0) return;
    const cards = grid.querySelectorAll<HTMLElement>(".mp-card-wrapper");
    const slice = Array.from(cards).slice(-Math.min(items.length, 20));
    if (slice.length === 0) return;
    gsap.fromTo(slice, { opacity: 0, y: 30 }, {
      opacity: 1, y: 0, duration: 0.45, ease: "power2.out", stagger: 0.06,
      scrollTrigger: { trigger: slice[0], start: "top 90%", once: true },
    });
  }, [items]);

  const fetchItems = useCallback(async (opts: {
    cat?: string; q?: string; p?: number; append?: boolean;
  }) => {
    const { cat = category, q = search, p = 1, append = false } = opts;
    if (append) setIsLoading(true); else setIsFetching(true);

    try {
      const params = new URLSearchParams({ page: String(p), limit: "20" });
      if (cat)  params.set("category", cat);
      if (q)    params.set("search", q);

      const res = await fetch(`${API_URL}/api/v1/marketplace?${params}`);
      if (!res.ok) throw new Error(`Server error (${res.status})`);

      const data = await res.json();
      const newItems: ContentItem[] = data.items ?? [];

      if (append) {
        setItems((prev) => [...prev, ...newItems]);
      } else {
        setItems(newItems);
      }
      setHasMore(newItems.length === 20);
      setPage(p);
    } catch (err: any) {
      console.error("[marketplace] fetch error:", err?.message);
      if (!append) setItems([]);
      setHasMore(false);
    } finally {
      setIsLoading(false);
      setIsFetching(false);
    }
  }, [category, search]);

  const handleCategoryChange = (val: string) => {
    setCategory(val);
    setPage(1);
    fetchItems({ cat: val, q: search, p: 1 });
    updateUrl(val, search);
  };

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
    fetchItems({ cat: category, q: searchInput, p: 1 });
    updateUrl(category, searchInput);
  };

  const updateUrl = (cat: string, q: string) => {
    const params = new URLSearchParams();
    if (cat) params.set("category", cat);
    if (q)   params.set("q", q);
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  // Infinite scroll — guard against firing during active filter/search fetch
  const loadMore = useCallback(() => {
    if (isLoading || isFetching || !hasMore) return;
    fetchItems({ cat: category, q: search, p: page + 1, append: true });
  }, [isLoading, isFetching, hasMore, fetchItems, category, search, page]);

  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <div>
      {/* Search + Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        {/* Search */}
        <div className="flex flex-1 gap-2">
          <input
            type="text"
            placeholder="Search works…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="flex-1 bg-[#221533] border border-[#3D2F5A] rounded-xl px-4 py-2.5 text-[#EDE8F5] text-sm placeholder-[#7A6E8E] focus:outline-none focus:border-[#F7FF88] transition-colors"
          />
          <button
            onClick={handleSearch}
            className="px-4 py-2.5 bg-[#F7FF88] text-[#0D0A14] rounded-xl text-sm font-semibold hover:bg-[#eef077] transition-colors"
          >
            Search
          </button>
        </div>

        {/* Category filters */}
        <div className="flex gap-2 flex-wrap sm:flex-nowrap">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              onClick={() => handleCategoryChange(cat.value)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                category === cat.value
                  ? "bg-[#F7FF88] text-[#0D0A14]"
                  : "bg-[#221533] border border-[#3D2F5A] text-[#7A6E8E] hover:text-[#EDE8F5] hover:border-[#5C4A7A]"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      {!isFetching && (
        <p className="text-[#7A6E8E] text-sm mb-5">
          {items.length > 0
            ? `Showing ${items.length}${hasMore ? "+" : ""} works${search ? ` for "${search}"` : ""}${category ? ` in ${category}` : ""}`
            : "No works found"}
        </p>
      )}

      {/* Grid */}
      {isFetching ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="animate-pulse bg-[#221533] rounded-xl aspect-[3/4]" />
          ))}
        </div>
      ) : items.length > 0 ? (
        <div
          ref={gridRef}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
        >
          {items.map((item) => (
            <div key={item.contentId} className="mp-card-wrapper">
              <ContentCard {...item} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-16 h-16 rounded-2xl bg-[#221533] border border-[#3D2F5A] flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7A6E8E" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <p className="text-[#7A6E8E]">No works found{search ? ` for "${search}"` : ""}</p>
          {(search || category) && (
            <button
              onClick={() => {
                setSearchInput(""); setSearch(""); setCategory("");
                fetchItems({ cat: "", q: "", p: 1 });
                updateUrl("", "");
              }}
              className="text-[#F7FF88] text-sm hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Infinite scroll trigger */}
      <div ref={loaderRef} className="flex justify-center py-10">
        {isLoading && (
          <div className="w-8 h-8 border-2 border-[#F7FF88] border-t-transparent rounded-full animate-spin" />
        )}
        {!hasMore && items.length > 0 && (
          <p className="text-[#7A6E8E] text-sm">All works loaded ✓</p>
        )}
      </div>
    </div>
  );
}
