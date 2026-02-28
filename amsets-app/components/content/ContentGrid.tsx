"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ContentCard } from "./ContentCard";

gsap.registerPlugin(ScrollTrigger);

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

interface ContentGridProps {
  initialItems: ContentItem[];
  category?: string;
  search?: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Infinite-scroll content grid with GSAP ScrollTrigger card reveal animations.
 * Each batch of cards animates from opacity:0, y:40 → opacity:1, y:0.
 */
export function ContentGrid({ initialItems, category, search }: ContentGridProps) {
  const [items, setItems] = useState<ContentItem[]>(initialItems);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const loaderRef = useRef<HTMLDivElement | null>(null);

  // Apply ScrollTrigger reveal animation to newly added cards
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const cards = grid.querySelectorAll<HTMLElement>(".content-card-wrapper");
    const newCards = Array.from(cards).slice(-items.length);

    // Guard: skip animation when there are no cards to avoid GSAP "target not found"
    if (newCards.length === 0) return;

    gsap.fromTo(
      newCards,
      { opacity: 0, y: 40 },
      {
        opacity: 1,
        y: 0,
        duration: 0.5,
        ease: "power2.out",
        stagger: 0.08,
        scrollTrigger: {
          trigger: newCards[0],
          start: "top 85%",
          once: true,
        },
      }
    );
  }, [items]);

  // Infinite scroll via IntersectionObserver
  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;
    setIsLoading(true);

    const nextPage = page + 1;
    const params = new URLSearchParams({
      page: String(nextPage),
      limit: "20",
    });
    if (category) params.set("category", category);
    if (search) params.set("search", search);

    try {
      const res = await fetch(`${API_URL}/api/v1/marketplace?${params}`);
      const data = await res.json();

      if (!data.items || data.items.length === 0) {
        setHasMore(false);
      } else {
        setItems((prev) => [...prev, ...data.items]);
        setPage(nextPage);
        if (data.items.length < 20) setHasMore(false);
      }
    } catch {
      setHasMore(false);
    } finally {
      setIsLoading(false);
    }
  }, [page, isLoading, hasMore, category, search]);

  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { threshold: 0.1 }
    );

    observer.observe(loader);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <>
      <div
        ref={gridRef}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
      >
        {items.map((item) => (
          <div key={item.contentId} className="content-card-wrapper">
            <ContentCard {...item} />
          </div>
        ))}
      </div>

      {/* Infinite scroll trigger */}
      <div ref={loaderRef} className="flex justify-center py-8 mt-4">
        {isLoading && (
          <div className="w-8 h-8 border-2 border-[#F7FF88] border-t-transparent rounded-full animate-spin" />
        )}
        {!hasMore && items.length > 0 && (
          <p className="text-[#7A6E8E] text-sm">You've seen everything ✓</p>
        )}
      </div>
    </>
  );
}
