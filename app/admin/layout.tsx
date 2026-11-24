"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type AuthState = "loading" | "authorized" | "forbidden";

const ADMIN_NAV_LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/quotas", label: "Quotas" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/admin";
  const [authState, setAuthState] = useState<AuthState>("loading");

  useEffect(() => {
    let cancelled = false;

    async function checkAdminAccess() {
      try {
        const res = await fetch("/api/admin/streams/health", {
          method: "GET",
          credentials: "include",
        });
        if (!cancelled) {
          setAuthState(res.ok ? "authorized" : "forbidden");
        }
      } catch {
        if (!cancelled) {
          setAuthState("forbidden");
        }
      }
    }

    checkAdminAccess();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authState === "loading") {
    return (
      <main
        className="container"
        style={{ padding: "2rem 1rem", maxWidth: "1100px", margin: "0 auto" }}
      >
        <p role="status" aria-live="polite">
          Verifying admin access…
        </p>
      </main>
    );
  }

  if (authState === "forbidden") {
    return (
      <main
        className="container"
        style={{ padding: "3rem 1rem", maxWidth: "640px", margin: "0 auto" }}
      >
        <section
          role="alert"
          className="card"
          style={{
            padding: "2rem",
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>
            403 — Forbidden
          </h1>
          <p style={{ color: "var(--muted)", marginBottom: "1.25rem" }}>
            You do not have permission to access the admin console.
          </p>
          <Link href="/dashboard" className="button button--primary">
            Return to Dashboard
          </Link>
        </section>
      </main>
    );
  }

  return (
    <div
      className="container"
      style={{ padding: "2rem 1rem", maxWidth: "1100px", margin: "0 auto" }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "1.5rem",
          paddingBottom: "1rem",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Admin Console</h1>
          <p style={{ color: "var(--muted)", margin: "0.25rem 0 0" }}>
            Privileged operational controls and audit-logged interventions.
          </p>
        </div>
        <nav aria-label="Admin sections" style={{ display: "flex", gap: "0.5rem" }}>
          {ADMIN_NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`button${active ? " button--primary" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {children}
    </div>
  );
}
