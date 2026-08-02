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
    title: "Zimlo — Leave your Mac. Stay in the loop.",
    description:
      "Bring Codex and Claude Code work from every Mac into one Feed. Review conclusions, images, video, and files, then act in seconds.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
      apple: "/apple-touch-icon.png",
    },
    openGraph: {
      title: "Zimlo — Leave your Mac. Stay in the loop.",
      description: "One Feed for Codex and Claude Code across every Mac—including images, video, files, approvals, and results.",
      type: "website",
      locale: "en_US",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "Zimlo — Leave your Mac. Stay in the loop." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Zimlo — Leave your Mac. Stay in the loop.",
      description: "One Feed for Codex and Claude Code across every Mac—including images, video, files, approvals, and results.",
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
