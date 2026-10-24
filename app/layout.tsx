import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "./components/ToastProvider";
import { CommandPaletteWrapper } from "./components/CommandPaletteWrapper";
import { ShortcutsOverlayWrapper } from "./components/ShortcutsOverlayWrapper";
import { SplashScreenWrapper } from "./components/SplashScreenWrapper";
import { AppBottomNav } from "./components/AppBottomNav";
import { SiteHeader } from "./components/SiteHeader";
import { ClientErrorReporter } from "./components/ClientErrorReporter";
import { ThemeController } from "./components/ThemeController";
import { getThemeScript } from "./utils/theme-noflash";
import { headers, cookies } from "next/headers";
import { resolveLocale, getLocaleDir } from "./i18n/locale";
import type { Locale } from "./i18n/locale";
import { I18nProvider } from "./i18n/I18nProvider";

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const headersList = await headers();
  const locale: Locale = resolveLocale(cookieStore, headersList);
  const dir = getLocaleDir(locale);

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: getThemeScript() }}
          suppressHydrationWarning
        />
      </head>
      <body>
        <ThemeController />
        <ClientErrorReporter />
        <I18nProvider locale={locale}>
          <ToastProvider>
            <SplashScreenWrapper />
            <CommandPaletteWrapper />
            <ShortcutsOverlayWrapper />
            <SiteHeader />
            {children}
            <AppBottomNav />
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}