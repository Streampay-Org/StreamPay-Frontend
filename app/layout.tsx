import type { Metadata } from "next";
import "./globals.css";
import dynamic from "next/dynamic";
import { ToastProvider } from "./components/ToastProvider";
import { getThemeScript } from "./utils/theme-noflash";

// Bundle budgets: Lazy-load non-critical UI (overlays, bottom nav, splash)
// to keep the initial JS bundle small for critical dashboard routes.
const SplashScreenWrapper = dynamic(() =>
  import("./components/SplashScreenWrapper").then((m) => m.SplashScreenWrapper)
);
const CommandPaletteWrapper = dynamic(() =>
  import("./components/CommandPaletteWrapper").then((m) => m.CommandPaletteWrapper)
);
const ShortcutsOverlayWrapper = dynamic(() =>
  import("./components/ShortcutsOverlayWrapper").then((m) => m.ShortcutsOverlayWrapper)
);
const AppBottomNav = dynamic(() =>
  import("./components/AppBottomNav").then((m) => m.AppBottomNav)
);

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
