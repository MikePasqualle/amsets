import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PageTransition } from "@/components/layout/PageTransition";
import { LibraryClient } from "@/components/content/LibraryClient";

export default function LibraryPage() {
  return (
    <>
      <Navbar />
      <PageTransition>
        <main className="min-h-screen max-w-7xl mx-auto px-6 pt-28 pb-16">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-3xl font-bold text-[#EDE8F5]">My Library</h1>
              <p className="text-[#7A6E8E] mt-1">Content you've purchased access to</p>
            </div>
          </div>
          <LibraryClient />
        </main>
      </PageTransition>
      <Footer />
    </>
  );
}
