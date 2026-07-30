"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface MobileLayoutProps {
  children: React.ReactNode;
}

export default function MobileLayout({ children }: MobileLayoutProps) {
  const pathname = usePathname();

  const navItems = [
    { href: "/streams", label: "Streams", icon: "⚡" },
    { href: "/activity", label: "Activity", icon: "📊" },
    { href: "/contacts", label: "Contacts", icon: "👥" },
    { href: "/settings", label: "Settings", icon: "⚙️" },
  ];

  return (
    <div className="mobile-shell">
      {/* Brand Header */}
      <header className="mobile-shell__header">
        <div className="mobile-shell__brand">
          <span className="mobile-shell__logo" aria-hidden="true">🦊</span>
          <span className="mobile-shell__title">GrantFox</span>
        </div>
        <div className="mobile-shell__status" aria-label="Network Status: Active">
          <span className="mobile-shell__status-dot" />
          <span className="mobile-shell__status-text">Testnet</span>
        </div>
      </header>

      {/* Content Area */}
      <main className="mobile-shell__content">
        {children}
      </main>

      {/* Navigation Bar */}
      <nav className="mobile-shell__nav" aria-label="Mobile Navigation">
        <ul className="mobile-shell__nav-list">
          {navItems.map((item) => {
            const isActive = pathname ? pathname.startsWith(item.href) : false;
            return (
              <li key={item.href} className="mobile-shell__nav-item">
                <Link
                  href={item.href}
                  className={`mobile-shell__nav-link${isActive ? " mobile-shell__nav-link--active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                >
                  <span className="mobile-shell__nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="mobile-shell__nav-label">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <style jsx global>{`
        .mobile-shell {
          display: flex;
          flex-direction: column;
          min-height: 100vh;
          max-width: 480px;
          margin: 0 auto;
          background: var(--background, #0a0a0f);
          border-left: 1px solid var(--border, #27272a);
          border-right: 1px solid var(--border, #27272a);
          position: relative;
        }

        .mobile-shell__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem 1.25rem;
          background: var(--panel-elevated, #17171f);
          border-bottom: 1px solid var(--border, #27272a);
          position: sticky;
          top: 0;
          z-index: 100;
        }

        .mobile-shell__brand {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .mobile-shell__logo {
          font-size: 1.25rem;
        }

        .mobile-shell__title {
          font-weight: 700;
          font-size: 1.1rem;
          letter-spacing: -0.02em;
          color: var(--foreground, #e4e4e7);
        }

        .mobile-shell__status {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          background: rgba(34, 197, 94, 0.1);
          border: 1px solid rgba(34, 197, 94, 0.2);
          padding: 0.25rem 0.6rem;
          border-radius: 999px;
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--accent, #22c55e);
        }

        .mobile-shell__status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent, #22c55e);
          box-shadow: 0 0 8px var(--accent, #22c55e);
        }

        .mobile-shell__content {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 1rem 1.25rem calc(4.5rem + env(safe-area-inset-bottom)) 1.25rem;
          overflow-y: auto;
        }

        .mobile-shell__nav {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          max-width: 480px;
          margin: 0 auto;
          background: var(--panel-elevated, #17171f);
          border-top: 1px solid var(--border, #27272a);
          padding-bottom: env(safe-area-inset-bottom, 0px);
          z-index: 100;
          box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
        }

        .mobile-shell__nav-list {
          display: flex;
          list-style: none;
          margin: 0;
          padding: 0;
        }

        .mobile-shell__nav-item {
          flex: 1;
        }

        .mobile-shell__nav-link {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.25rem;
          height: 3.5rem;
          color: var(--muted-light, #a1a1aa);
          text-decoration: none;
          transition: color 150ms ease;
          outline: none;
        }

        .mobile-shell__nav-link:hover {
          color: var(--foreground, #e4e4e7);
          text-decoration: none;
        }

        .mobile-shell__nav-link:focus-visible {
          box-shadow: inset 0 0 0 2px var(--accent, #22c55e);
        }

        .mobile-shell__nav-link--active {
          color: var(--accent, #22c55e);
        }

        .mobile-shell__nav-icon {
          font-size: 1.2rem;
          line-height: 1;
        }

        .mobile-shell__nav-label {
          font-size: 0.72rem;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
