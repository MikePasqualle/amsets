import fs from "fs";
import path from "path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";

export const metadata = {
  title: "AMSETS Whitepaper",
  description:
    "Technical whitepaper for AMSETS — the decentralized IP rights ledger on Solana.",
};

function getWhitepaperContent(): string {
  // Walk up from the Next.js app dir to the monorepo root where whitepaper.md lives.
  const candidates = [
    path.join(process.cwd(), "whitepaper.md"),
    path.join(process.cwd(), "..", "whitepaper.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  return "# Whitepaper\n\n_Coming soon._";
}

export default function WhitepaperPage() {
  const content = getWhitepaperContent();

  return (
    <>
      <Navbar />
      <main className="min-h-screen max-w-4xl mx-auto px-6 pt-28 pb-24">
        {/* Header badge */}
        <div className="mb-12 flex flex-col items-start gap-4">
          <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold bg-[#F7FF88]/10 text-[#F7FF88] border border-[#F7FF88]/30">
            Version 1.0 · February 2026
          </span>
        </div>

        {/* Markdown content */}
        <div className="prose-amsets">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => (
                <h1 className="text-4xl md:text-5xl font-black text-[#F7FF88] mb-8 leading-tight">
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 className="text-2xl font-bold text-[#EDE8F5] mt-14 mb-5 pb-3 border-b border-[#3D2F5A]">
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="text-lg font-semibold text-[#81D0B5] mt-8 mb-3">
                  {children}
                </h3>
              ),
              p: ({ children }) => (
                <p className="text-[#EDE8F5]/85 leading-relaxed mb-4">{children}</p>
              ),
              ul: ({ children }) => (
                <ul className="list-disc list-inside text-[#EDE8F5]/80 mb-4 space-y-1 pl-2">
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol className="list-decimal list-inside text-[#EDE8F5]/80 mb-4 space-y-1 pl-2">
                  {children}
                </ol>
              ),
              li: ({ children }) => <li className="leading-relaxed">{children}</li>,
              table: ({ children }) => (
                <div className="overflow-x-auto my-6">
                  <table className="w-full text-sm border-collapse">{children}</table>
                </div>
              ),
              thead: ({ children }) => (
                <thead className="bg-[#221533]">{children}</thead>
              ),
              th: ({ children }) => (
                <th className="px-4 py-3 text-left text-[#F7FF88] font-semibold border border-[#3D2F5A]">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="px-4 py-3 text-[#EDE8F5]/80 border border-[#3D2F5A]">
                  {children}
                </td>
              ),
              tr: ({ children }) => (
                <tr className="hover:bg-[#221533]/50 transition-colors">{children}</tr>
              ),
              code: ({ children, className }) => {
                const isBlock = className?.includes("language-");
                if (isBlock) {
                  return (
                    <pre className="bg-[#0D0A14] border border-[#3D2F5A] rounded-xl p-5 my-5 overflow-x-auto">
                      <code className="text-[#81D0B5] text-sm font-mono leading-relaxed">
                        {children}
                      </code>
                    </pre>
                  );
                }
                return (
                  <code className="bg-[#221533] text-[#F7FF88] px-1.5 py-0.5 rounded text-sm font-mono">
                    {children}
                  </code>
                );
              },
              blockquote: ({ children }) => (
                <blockquote className="border-l-4 border-[#F7FF88] pl-5 my-5 text-[#7A6E8E] italic">
                  {children}
                </blockquote>
              ),
              hr: () => <hr className="border-[#3D2F5A] my-10" />,
              strong: ({ children }) => (
                <strong className="text-[#EDE8F5] font-semibold">{children}</strong>
              ),
              a: ({ href, children }) => (
                <a
                  href={href}
                  className="text-[#81D0B5] hover:text-[#F7FF88] underline underline-offset-2 transition-colors"
                  target={href?.startsWith("http") ? "_blank" : undefined}
                  rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
                >
                  {children}
                </a>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </main>
      <Footer />
    </>
  );
}
