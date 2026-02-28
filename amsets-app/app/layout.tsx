import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/providers/Providers";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AMSETS — Digital IP Rights Ledger",
  description:
    "Register, protect and monetize your intellectual property on Solana. The decentralized ledger for creators.",
  keywords: ["NFT", "IP rights", "blockchain", "Solana", "copyright", "digital assets"],
  openGraph: {
    title: "AMSETS — Digital IP Rights Ledger",
    description: "Register and monetize your IP on Solana",
    images: ["/brand/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
