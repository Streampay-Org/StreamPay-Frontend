import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "./components/ToastProvider";
import { CommandPaletteLauncher } from "./components/CommandPaletteLauncher";
import { ShortcutsOverlayLauncher } from "./components/ShortcutsOverlayLauncher";
import { SplashScreenWrapper } from "./components/SplashScreenWrapper";
import { AppBottomNav } from "./components/AppBottomNav";
import { SiteHeader } from "./components/SiteHeader";
import { ClientErrorReporter } from "./components/ClientErrorReporter";
import { ThemeController } from "./components/ThemeController";
import { getThemeScript } from "./utils/theme-noflash";
import RootShell from "./components/RootShell";
import { getSiteUrl, getSiteUrlObject } from "./lib/site-url";

const siteUrl = getSiteUrl();
const siteTitle = "StreamPay - Payment Streaming";
const siteDescription = "Real-time payment streaming on Stellar";

export const metadata: Metadata = {
  metadataBase: getSiteUrlObject(),
  title: {
    default: siteTitle,
    template: "%s | StreamPay",
  },
  description: siteDescription,
  openGraph: {
    type: "website",
    siteName: "StreamPay",
    title: siteTitle,
    description: siteDescription,
    url: siteUrl,
    images: [
      {
        url: "/icon.svg",
        alt: "StreamPay",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: siteTitle,
    description: siteDescription,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0f" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: getThemeScript() }}
          suppressHydrationWarning
        />
      </head>
      <body>
       <RootShell>{children}</RootShell>
      </body>
    </html>
  );
}
