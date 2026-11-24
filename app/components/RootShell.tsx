"use client";

import { usePathname } from "next/navigation";

import { ThemeController } from "@/app/components/ThemeController";
import { ClientErrorReporter } from "@/app/components/ClientErrorReporter";
import { ToastProvider } from "@/app/components/ToastProvider";
import { SplashScreenWrapper } from "@/app/components/SplashScreenWrapper";
import { CommandPaletteLauncher } from "@/app/components/CommandPaletteLauncher";
import { ShortcutsOverlayLauncher } from "@/app/components/ShortcutsOverlayLauncher";
import { SiteHeader } from "@/app/components/SiteHeader";
import { AppBottomNav } from "@/app/components/AppBottomNav";

export default function RootShell({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();

  if (pathname?.startsWith("/embed/")) {
    return <>{children}</>;
  }

  return (
    <>
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
    </>
  );
}