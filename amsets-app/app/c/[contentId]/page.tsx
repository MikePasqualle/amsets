import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PageTransition } from "@/components/layout/PageTransition";
import { ContentPageClient } from "@/components/content/ContentPageClient";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// Next.js 15+ — params is a Promise and must be awaited before accessing properties.
type Params = Promise<{ contentId: string }>;

async function getContent(contentId: string) {
  try {
    const res = await fetch(`${API_URL}/api/v1/content/${contentId}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function ContentPage({ params }: { params: Params }) {
  const { contentId } = await params;
  const content = await getContent(contentId);

  if (!content) {
    return (
      <>
        <Navbar />
        <main className="min-h-screen flex items-center justify-center">
          <p className="text-[#7A6E8E]">Content not found.</p>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Navbar />
      <PageTransition>
        <ContentPageClient content={content} />
      </PageTransition>
      <Footer />
    </>
  );
}
