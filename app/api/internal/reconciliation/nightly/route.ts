/**
 * Nightly reconciliation: DB vs indexer diff.
 *
 * Auth: bearer token via X-Cron-Secret (or Authorization: Bearer <secret>),
 * timing-safe-compared against RECON_CRON_SECRET env var. Fails closed when
 * the env var is not configured.
 *
 * Input : optional { sinceISO?, dryRun?, pageSize? }  (strict: unknown keys rejected)
 * Output: 200 OK with { ok, correlationId, summary, diff, nextCursor }
 * Errors: standardized envelope { error: { code, message, correlationId, details? } }
 *
 * Cron example:
 *   curl -X POST -H "X-Cron-Secret: $RECON_CRON_SECRET" \
 *        -H "X-Request-Id: recon-$(date -u +%Y%m%dT%H%M%SZ)" \
 *        https://<host>/api/internal/reconciliation/nightly
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { fetchAllDBRows, fetchAllIndexerRows, diffRows } from "./_pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- Error envelope -----------------------------------------------------------

interface ErrorEnvelope {
  error: { code: string; message: string; correlationId: string; details?: unknown };
}
function errorEnvelope(
  code: string,
  message: string,
  correlationId: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    error: {
      code, message, correlationId,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

// --- Tiny structured logger (one JSON line per event) -------------------------

interface LogCtx { correlationId: string; route: string }
function makeChild(ctx: LogCtx) {
  const emit = (level: string, event: string, data: Record<string, unknown>) =>
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level, event, ...ctx, ts: new Date().toISOString(), ...data }));
  return {
    info:  (e: string, d: Record<string, unknown> = {}) => emit("info",  e, d),
    warn:  (e: string, d: Record<string, unknown> = {}) => emit("warn",  e, d),
    error: (e: string, d: Record<string, unknown> = {}) => emit("error", e, d),
  };
}

// --- Boundary input validation (no external deps) ----------------------------

interface ReconcileInput {
  sinceISO?: string;
  dryRun?: boolean;
  pageSize?: number;
}

type ValidationResult =
  | { ok: true; data: ReconcileInput }
  | { ok: false; issues: string[] };

function validateInput(raw: unknown): ValidationResult {
  const issues: string[] = [];
  if (raw === undefined || raw === null) return { ok: true, data: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: ["body must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(["sinceISO", "dryRun", "pageSize"]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) issues.push(`unknown field: ${k}`);
  }
  const data: ReconcileInput = {};
  if ("sinceISO" in obj) {
    if (typeof obj.sinceISO !== "string" || Number.isNaN(Date.parse(obj.sinceISO))) {
      issues.push("sinceISO must be a valid ISO-8601 datetime string");
    } else {
      data.sinceISO = obj.sinceISO;
    }
  }
  if ("dryRun" in obj) {
    if (typeof obj.dryRun !== "boolean") issues.push("dryRun must be a boolean");
    else data.dryRun = obj.dryRun;
  }
  if ("pageSize" in obj) {
    if (
      typeof obj.pageSize !== "number" ||
      !Number.isInteger(obj.pageSize) ||
      obj.pageSize < 100 ||
      obj.pageSize > 5000
    ) {
      issues.push("pageSize must be an integer in [100, 5000]");
    } else {
      data.pageSize = obj.pageSize;
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, data };
}

// --- Cron authorization (constant-time compare) ------------------------------

async function authorizeCron(req: NextRequest): Promise<boolean> {
  const expected = process.env.RECON_CRON_SECRET;
  if (!expected) return false; // fail closed
  const provided =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- Pipeline ----------------------------------------------------------------

interface ReconciliationResult {
  startedAt: string;
  finishedAt: string;
  sinceISO: string;
  dryRun: boolean;
  summary: import("./_pipeline").ReconciliationSummary;
  diff: import("./_pipeline").ReconciliationDiff;
  nextCursor: string | null;
}

async function runNightlyReconciliation(
  input: ReconcileInput,
  log: ReturnType<typeof makeChild>,
): Promise<ReconciliationResult> {
  const startedAt = new Date();
  const sinceISO = input.sinceISO ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pageSize = input.pageSize ?? 1000;

  log.info("recon.fetch_db", { sinceISO, pageSize });
  const dbRows = await fetchAllDBRows(sinceISO, pageSize);

  log.info("recon.fetch_indexer", { sinceISO, pageSize });
  const indexerRows = await fetchAllIndexerRows(sinceISO, pageSize);

  log.info("recon.diff", { db: dbRows.length, indexer: indexerRows.length });
  const { diff, summary } = diffRows(dbRows, indexerRows);

  if (!input.dryRun && (
    summary.missingInIndexerCount ||
    summary.missingInDBCount ||
    summary.mismatchedAmountCount ||
    summary.mismatchedStatusCount
  )) {
    log.warn("recon.divergence", summary as unknown as Record<string, unknown>);
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    sinceISO,
    dryRun: input.dryRun ?? false,
    summary,
    diff,
    nextCursor: null,
  };
}

// --- Route handler -----------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const correlationId =
    req.headers.get("x-request-id") ??
    req.headers.get("x-correlation-id") ??
    crypto.randomUUID();

  const log = makeChild({ correlationId, route: "/api/internal/reconciliation/nightly" });

  try {
    if (!(await authorizeCron(req))) {
      log.warn("reconciliation.unauthorized", {
        ip: req.headers.get("x-forwarded-for") ?? "unknown",
        ua: req.headers.get("user-agent") ?? "unknown",
      });
      return NextResponse.json(
        errorEnvelope("UNAUTHORIZED", "Invalid or missing cron secret", correlationId),
        { status: 401, headers: { "x-correlation-id": correlationId } },
      );
    }

    const raw = await req.json().catch(() => ({}));
    const parsed = validateInput(raw);
    if (!parsed.ok) {
      log.warn("reconciliation.invalid_input", { issues: parsed.issues });
      return NextResponse.json(
        errorEnvelope("VALIDATION_FAILED", "Invalid request body", correlationId, parsed.issues),
        { status: 400, headers: { "x-correlation-id": correlationId } },
      );
    }

    const result = await runNightlyReconciliation(parsed.data, log);

    return NextResponse.json(
      { ok: true, correlationId, ...result },
      { status: 200, headers: { "x-correlation-id": correlationId } },
    );
  } catch (err) {
    log.error("reconciliation.failed", {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      errorEnvelope("INTERNAL", "Reconciliation failed", correlationId),
      { status: 500, headers: { "x-correlation-id": correlationId } },
    );
  }
}

