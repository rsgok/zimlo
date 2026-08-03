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
    title: "Zimlo — Your Agents keep working. Your iPhone keeps you in control.",
    description:
      "An iPhone attention layer for Codex and Claude Code: a TikTok-style main Feed, an X-style profile for every session, and first-class image, video, document, and file artifacts.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      title: "Zimlo — Your Agents keep working. Your iPhone keeps you in control.",
      description: "A TikTok-style Agent Feed, X-style Task Profiles, and rich artifacts—on iPhone, across every Mac.",
      type: "website",
      locale: "en_US",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "Zimlo for iPhone" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Zimlo — Your Agents keep working. Your iPhone keeps you in control.",
      description: "A TikTok-style Agent Feed, X-style Task Profiles, and rich artifacts—on iPhone, across every Mac.",
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
