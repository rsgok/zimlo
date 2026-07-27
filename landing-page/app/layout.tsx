import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: "Zimlo — The edited feed for your AI work",
    description:
      "Zimlo turns Codex and Claude Code activity into a calm, swipeable feed of the conclusions, decisions, and results that matter.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      title: "Zimlo — Your AI work, edited down to what matters",
      description: "Browse important agent work one card at a time. Approve, reply, or keep scrolling.",
      type: "website",
      locale: "en_US",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "Zimlo — Your AI work, edited down to what matters" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Zimlo — Your AI work, edited down to what matters",
      description: "Browse important agent work one card at a time. Approve, reply, or keep scrolling.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
