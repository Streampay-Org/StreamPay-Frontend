"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import {
  DEFAULT_ACCENT_COLOR,
  getAllowedLogoHosts,
  MAX_MESSAGE_LENGTH,
  normalizeReceiptTheme,
  validateReceiptTheme,
  type ReceiptTheme,
} from "../../lib/receipt-theme";
import type { Stream } from "../../types/openapi";
import { StreamReceipt } from "../StreamReceipt";
import styles from "./ReceiptThemeEditor.module.css";

type Draft = { accentColor: string; logoUrl: string; message: string };
type FieldErrors = Partial<Record<keyof Draft | "body", string>>;
type ThemeData = { theme: ReceiptTheme | null; canEdit: boolean; logoAllowedHosts: string };
type ThemeResponse = { data?: ThemeData; error?: { message: string; fields?: FieldErrors } };

export interface ReceiptThemeEditorHandle {
  save: () => Promise<boolean>;
}

const previewDate = "2026-01-01T00:00:00Z";
const previewStream: Stream = {
  id: "sample-stream",
  recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  label: "Sample recipient",
  rate: "120 XLM / month",
  schedule: "Pays every 30 days",
  status: "active",
  token: "XLM",
  createdAt: previewDate,
  updatedAt: previewDate,
};

function draftFrom(theme: ReceiptTheme | null): Draft {
  return {
    accentColor: theme?.accentColor ?? DEFAULT_ACCENT_COLOR,
    logoUrl: theme?.logoUrl ?? "",
    message: theme?.message ?? "",
  };
}

function contrastOnWhite(color: string) {
  const hex = color.slice(1);
  const channels = hex.length === 3
    ? hex.split("").map((channel) => channel.repeat(2))
    : hex.match(/../g)!;
  const [red, green, blue] = channels.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05);
}

interface ThemeFormProps {
  orgId: string;
  wallet: string;
  token: string;
  onDirtyChange: (dirty: boolean) => void;
}

const ThemeForm = forwardRef<ReceiptThemeEditorHandle, ThemeFormProps>(function ThemeForm(
  { orgId, wallet, token, onDirtyChange }, ref,
) {
  const [data, setData] = useState<ThemeData>();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState("");
  const endpoint = `/api/orgs/${encodeURIComponent(orgId)}/receipt-theme`;

  const actorHeaders = useMemo(() => ({
    "Actor-Wallet-Address": wallet,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token, wallet]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(endpoint, {
          headers: actorHeaders,
          signal: controller.signal,
        });
        const result: ThemeResponse = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok || !result.data) {
          setError(result.error?.message ?? "Could not load the receipt theme.");
          return;
        }
        setData(result.data);
        setDraft(draftFrom(result.data.theme));
      } catch {
        if (!controller.signal.aborted) setError("Could not load the receipt theme.");
      }
    }
    void load();
    return () => controller.abort();
  }, [endpoint, actorHeaders]);

  const saved = draftFrom(data?.theme ?? null);
  const dirty = draft.accentColor !== saved.accentColor
    || draft.logoUrl !== saved.logoUrl || draft.message !== saved.message;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const logoHosts = useMemo(() => getAllowedLogoHosts(data?.logoAllowedHosts ?? ""), [data?.logoAllowedHosts]);
  const errors = { ...validateReceiptTheme(draft, logoHosts), ...fieldErrors };
  const preview = normalizeReceiptTheme(draft, logoHosts);
  const contrast = contrastOnWhite(preview.accentColor);

  async function write(method: "PUT" | "DELETE") {
    if (busy || !data?.canEdit) return false;
    if (method === "PUT" && Object.keys(errors).length) return false;
    setBusy(true);
    setError("");
    setFieldErrors({});
    setStatus("");
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { ...actorHeaders, "Content-Type": "application/json" },
        body: method === "PUT" ? JSON.stringify(draft) : undefined,
      });
      const result: ThemeResponse = await response.json();
      if (!response.ok || !result.data) {
        setError(result.error?.message ?? "Could not update the receipt theme.");
        setFieldErrors(result.error?.fields ?? {});
        return false;
      }
      setData(result.data);
      setDraft(draftFrom(result.data.theme));
      setStatus(method === "PUT" ? "Receipt theme saved." : "Receipt theme reset.");
      onDirtyChange(false);
      return true;
    } catch {
      setError("Could not update the receipt theme.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  useImperativeHandle(ref, () => ({ save: () => write("PUT") }));

  function change(field: keyof Draft, value: string) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setFieldErrors({});
    setError("");
    setStatus("");
  }

  if (!data) return error ? <p role="alert">{error}</p> : <p role="status">Loading receipt theme…</p>;

  return (
    <>
      {!data.canEdit && <p>Only organization owners can edit this theme.</p>}
      <form noValidate onSubmit={(event) => { event.preventDefault(); void write("PUT"); }}>
        <fieldset disabled={!data.canEdit || busy} className={styles.fields}>
          <legend>Receipt branding</legend>
          <div className={styles.field}>
            <label htmlFor="receipt-accent-color">Accent colour</label>
            <input id="receipt-accent-color" value={draft.accentColor}
              onChange={(event) => change("accentColor", event.target.value)}
              aria-invalid={!!errors.accentColor} aria-describedby="receipt-contrast" />
            <p id="receipt-contrast">
              {errors.accentColor
                ? <span role="alert">{errors.accentColor}</span>
                : `Contrast against white: ${contrast.toFixed(2)}:1. Aim for at least 3:1 for a visible border.`}
            </p>
          </div>
          <div className={styles.field}>
            <label htmlFor="receipt-logo-url">Logo URL</label>
            <input id="receipt-logo-url" type="url" value={draft.logoUrl}
              onChange={(event) => change("logoUrl", event.target.value)}
              aria-invalid={!!errors.logoUrl} aria-describedby="receipt-logo-help" />
            <p id="receipt-logo-help">
              {errors.logoUrl ? <span role="alert">{errors.logoUrl}</span> : "Optional HTTPS image URL from an approved host."}
            </p>
          </div>
          <div className={styles.field}>
            <label htmlFor="receipt-message">Message</label>
            <textarea id="receipt-message" value={draft.message}
              onChange={(event) => change("message", event.target.value)}
              aria-invalid={!!errors.message} aria-describedby="receipt-message-count" />
            <p id="receipt-message-count">
              {draft.message.length} / {MAX_MESSAGE_LENGTH} characters
              {errors.message && <><br /><span role="alert">{errors.message}</span></>}
            </p>
          </div>
          {data.canEdit && (
            <div className={styles.actions}>
              <button type="submit" className="button button--primary"
                disabled={!dirty || !!Object.keys(errors).length}>Save theme</button>
              <button type="button" className="button button--secondary"
                disabled={!data.theme} onClick={() => void write("DELETE")}>Reset theme</button>
            </div>
          )}
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <h3>Receipt preview</h3>
      <StreamReceipt
        stream={previewStream}
        generatedAt={previewDate}
        theme={data.theme || dirty ? preview : undefined}
        hideToolbar
      />
    </>
  );
});

interface ReceiptThemeEditorProps {
  onDirtyChange: (dirty: boolean) => void;
  confirmNavigation: (origin?: HTMLElement | null) => Promise<boolean>;
}

export const ReceiptThemeEditor = forwardRef<ReceiptThemeEditorHandle, ReceiptThemeEditorProps>(
  function ReceiptThemeEditor({ onDirtyChange, confirmNavigation }, ref) {
    const [orgId, setOrgId] = useState("");
    const [wallet, setWallet] = useState("");
    const [token, setToken] = useState("");
    const [selection, setSelection] = useState<{
      orgId: string;
      wallet: string;
      token: string;
      version: number;
    }>();

    return (
      <>
        <form className={styles.fields} onSubmit={async (event) => {
          event.preventDefault();
          const nextOrg = orgId.trim();
          const nextWallet = wallet.trim();
          if (!nextOrg || !nextWallet) return;
          if (await confirmNavigation(document.activeElement as HTMLElement | null)) {
            setSelection((previous) => ({
              orgId: nextOrg,
              wallet: nextWallet,
              token: token.trim(),
              version: (previous?.version ?? 0) + 1,
            }));
          }
        }}>
          <div className={styles.field}>
            <label htmlFor="receipt-org">Organization ID</label>
            <input id="receipt-org" required value={orgId} onChange={(event) => setOrgId(event.target.value)} />
          </div>
          <div className={styles.field}>
            <label htmlFor="receipt-wallet">Wallet address</label>
            <input id="receipt-wallet" required value={wallet} onChange={(event) => setWallet(event.target.value)} />
          </div>
          <div className={styles.field}>
            <label htmlFor="receipt-token">Wallet session token</label>
            <input id="receipt-token" type="password" autoComplete="off" value={token}
              aria-describedby="receipt-token-help" onChange={(event) => setToken(event.target.value)} />
            <p id="receipt-token-help">Enter the session token issued after signing a wallet challenge.</p>
          </div>
          <button type="submit" className="button button--secondary">Load receipt theme</button>
        </form>
        {selection && (
          <section aria-label={`Receipt theme for ${selection.orgId}`}>
            <h3>Theme for {selection.orgId}</h3>
            <ThemeForm key={selection.version} ref={ref} orgId={selection.orgId} wallet={selection.wallet} token={selection.token}
              onDirtyChange={onDirtyChange} />
          </section>
        )}
      </>
    );
  },
);
