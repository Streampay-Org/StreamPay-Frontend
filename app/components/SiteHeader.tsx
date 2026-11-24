"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletConnection } from "./WalletConnection";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/streams", label: "Streams" },
  { href: "/approvals", label: "Approvals" },
  { href: "/activity", label: "Activity" },
  { href: "/contacts", label: "Contacts" },
  { href: "/templates", label: "Templates" },
  { href: "/orgs", label: "Orgs" },
  { href: "/settings", label: "Settings" },
  { href: "/docs", label: "Docs" },
];

/** Top navigation shown on every page (hidden on small screens, where the bottom nav is used). */
export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkIdentity() {
      try {
        const res = await fetch("/api/identity/me", { credentials: "include" });
        if (!res.ok) return;
        const json = await res.json();
        const data = json?.data;
        const admin =
          data?.is_admin === true ||
          data?.role === "admin";
        if (!cancelled) {
          setIsAdmin(admin);
        }
      } catch {
        // Ignore unauthenticated or network errors
      }
    }

    checkIdentity();
    return () => {
      cancelled = true;
    };
  }, []);

  const links = isAdmin ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS;

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-header__brand" aria-label="StreamPay home">
          <span className="site-header__logo" aria-hidden="true">≋</span>
          Stream<strong>Pay</strong>
        </Link>
        <nav className="site-header__nav" aria-label="Primary">
          {links.map((l) => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`site-header__link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <Link href="/streams/new" className="button button--primary site-header__cta">
          New stream
        </Link>
        <WalletConnection />
      </div>
    </header>
  );
}

export default SiteHeader;
