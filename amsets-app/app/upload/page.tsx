import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { PageTransition } from "@/components/layout/PageTransition";
import { UploadSteps } from "@/components/content/UploadSteps";

export default function UploadPage() {
  return (
    <>
      <Navbar />
      <PageTransition>
        <main className="min-h-screen max-w-2xl mx-auto px-6 pt-28 pb-16">
          <h1 className="text-3xl font-bold text-[#EDE8F5] mb-2">Publish Your Work</h1>
          <p className="text-[#7A6E8E] mb-10">
            5 steps to register your IP on-chain and start selling access.
          </p>
          <UploadSteps />
        </main>
      </PageTransition>
      <Footer />
    </>
  );
}
