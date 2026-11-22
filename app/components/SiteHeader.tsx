"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/streams", label: "Streams" },
  { href: "/activity", label: "Activity" },
  { href: "/contacts", label: "Contacts" },
  { href: "/templates", label: "Templates" },
  { href: "/settings", label: "Settings" },
  { href: "/docs", label: "Docs" },
];

/** Top navigation shown on every page (hidden on small screens, where the bottom nav is used). */
export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-header__brand" aria-label="StreamPay home">
          <span className="site-header__logo" aria-hidden="true">≋</span>
          Stream<strong>Pay</strong>
        </Link>
        <nav className="site-header__nav" aria-label="Primary">
          {LINKS.map((l) => {
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
      </div>
    </header>
  );
}

export default SiteHeader;
