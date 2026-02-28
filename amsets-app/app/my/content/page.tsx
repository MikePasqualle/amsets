import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PageTransition } from "@/components/layout/PageTransition";
import { MyContentClient } from "@/components/content/MyContentClient";

export default function MyContentPage() {
  return (
    <>
      <Navbar />
      <PageTransition>
        <main className="min-h-screen max-w-7xl mx-auto px-6 pt-28 pb-16">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-3xl font-bold text-[#EDE8F5]">My Content</h1>
              <p className="text-[#7A6E8E] mt-1">Works you've published on AMSETS</p>
            </div>
            <a href="/upload">
              <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#F7FF88] text-[#0D0A14] text-sm font-semibold hover:bg-[#eef077] transition-colors">
                + Publish New
              </span>
            </a>
          </div>
          <MyContentClient />
        </main>
      </PageTransition>
      <Footer />
    </>
  );
}
