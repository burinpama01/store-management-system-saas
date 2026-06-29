import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { getPlatformLogoUrl } from "@/modules/billing/platform-settings";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Store Management",
  description: "SaaS store management system",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const logoUrl = await getPlatformLogoUrl().catch(() => null);
  const brandStyle = {
    "--platform-logo": `url(${logoUrl ?? "/logo.png"})`,
  } as CSSProperties;
  return (
    <html
      lang="th"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" style={brandStyle}>
        {children}
      </body>
    </html>
  );
}
