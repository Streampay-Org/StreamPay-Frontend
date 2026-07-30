import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "./components/ToastProvider";
import { CommandPaletteWrapper } from "./components/CommandPaletteWrapper";
import { ShortcutsOverlayWrapper } from "./components/ShortcutsOverlayWrapper";
import { SplashScreenWrapper } from "./components/SplashScreenWrapper";
import { AppBottomNav } from "./components/AppBottomNav";
import { getThemeScript } from "./utils/theme-noflash";

export const metadata: Metadata = {
  title: "StreamPay - Payment Streaming",
  description: "Real-time payment streaming on Stellar",
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
        <ToastProvider>
          <SplashScreenWrapper />
          <CommandPaletteWrapper />
          <ShortcutsOverlayWrapper />
          {children}
          <AppBottomNav />
        </ToastProvider>
      </body>
    </html>
  );
}
