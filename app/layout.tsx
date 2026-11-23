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

export const metadata: Metadata = {
  title: "StreamPay - Payment Streaming",
  description: "Real-time payment streaming on Stellar",
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
        <ThemeController />
        <ClientErrorReporter />
        <ToastProvider>
          <SplashScreenWrapper />
          <CommandPaletteLauncher />
          <ShortcutsOverlayLauncher />
          <SiteHeader />
          {children}
          <AppBottomNav />
        </ToastProvider>
      </body>
    </html>
  );
}
