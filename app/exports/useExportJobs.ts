"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExportJob } from "@/app/types/openapi";

export type ExportFormat = "csv" | "json";

export interface ExportRequestParams {
  format: ExportFormat;
  startDate?: string;
  endDate?: string;
}

export interface UseExportJobsOptions {
  pollIntervalMs?: number;
  maxBackoffMs?: number;
}

export interface UseExportJobsResult {
  jobs: ExportJob[];
  isLoading: boolean;
  isSubmitting: boolean;
  error: string | null;
  submitError: string | null;
  rateLimitSecondsLeft: number;
  isRateLimited: boolean;
  requestExport: (params: ExportRequestParams) => Promise<ExportJob | null>;
  retryExport: (job: ExportJob) => Promise<ExportJob | null>;
  refresh: () => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export function parseRetryAfterSeconds(headerValue: string | null): number {
  if (!headerValue) return DEFAULT_RETRY_AFTER_SECONDS;
  const trimmed = headerValue.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffSeconds = Math.ceil((dateMs - Date.now()) / 1000);
    if (diffSeconds > 0) return diffSeconds;
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

async function extractApiErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
      message?: string;
    };
    return body?.error?.message ?? body?.message ?? null;
  } catch {
    return null;
  }
}

export function formatHttpErrorMessage(
  status: number,
  apiMessage: string | null,
  retryAfterSeconds?: number
): string {
  if (status === 401) {
    return "Authentication required (401). Please sign in to access data exports.";
  }
  if (status === 422) {
    return apiMessage
      ? `Invalid export request (422): ${apiMessage}`
      : "Invalid export request (422). Please check your parameters and try again.";
  }
  if (status === 429) {
    const seconds = retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
    return `Rate limit exceeded (429). Please wait ${seconds}s before requesting another export.`;
  }
  if (apiMessage) {
    return apiMessage;
  }
  return `Request failed with status ${status}.`;
}

export function useExportJobs(
  options: UseExportJobsOptions = {}
): UseExportJobsResult {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rateLimitSecondsLeft, setRateLimitSecondsLeft] = useState<number>(0);

  const mountedRef = useRef<boolean>(true);
  const lastEtagRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateLimitTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutiveErrorsRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const jobParamsRef = useRef<Map<string, ExportRequestParams>>(new Map());
  const jobsRef = useRef<ExportJob[]>([]);

  jobsRef.current = jobs;

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearRateLimitTimer = useCallback(() => {
    if (rateLimitTimerRef.current !== null) {
      clearInterval(rateLimitTimerRef.current);
      rateLimitTimerRef.current = null;
    }
  }, []);

  const startRateLimitCooldown = useCallback(
    (seconds: number) => {
      clearRateLimitTimer();
      if (!mountedRef.current) return;

      const clamped = Math.max(1, Math.ceil(seconds));
      const deadline = Date.now() + clamped * 1000;
      setRateLimitSecondsLeft(clamped);

      rateLimitTimerRef.current = setInterval(() => {
        if (!mountedRef.current) {
          clearRateLimitTimer();
          return;
        }
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        if (remaining <= 0) {
          setRateLimitSecondsLeft(0);
          clearRateLimitTimer();
        } else {
          setRateLimitSecondsLeft(remaining);
        }
      }, 1_000);
    },
    [clearRateLimitTimer]
  );

  const hasPendingJobs = useCallback((list: ExportJob[]) => {
    return list.some((job) => job.status === "pending");
  }, []);

  const scheduleNextPollRef = useRef<((delayMs: number) => void) | null>(null);

  const fetchJobs = useCallback(
    async (isInitial = false) => {
      if (!mountedRef.current) return;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const headers: Record<string, string> = {};
      if (lastEtagRef.current) {
        headers["If-None-Match"] = lastEtagRef.current;
      }

      try {
        const response = await fetch("/api/exports", {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        if (!mountedRef.current) return;

        if (response.status === 304) {
          consecutiveErrorsRef.current = 0;
          setError(null);
          if (isInitial) setIsLoading(false);

          if (
            hasPendingJobs(jobsRef.current) &&
            (typeof document === "undefined" ||
              document.visibilityState !== "hidden")
          ) {
            scheduleNextPollRef.current?.(pollIntervalMs);
          }
          return;
        }

        if (!response.ok) {
          const retryAfter =
            response.status === 429
              ? parseRetryAfterSeconds(response.headers.get("Retry-After"))
              : undefined;
          const apiMessage = await extractApiErrorMessage(response);
          if (!mountedRef.current) return;

          setError(formatHttpErrorMessage(response.status, apiMessage, retryAfter));
          if (isInitial) setIsLoading(false);

          if (response.status === 429 && retryAfter) {
            startRateLimitCooldown(retryAfter);
          }

          consecutiveErrorsRef.current += 1;
          const backoffDelay = Math.min(
            pollIntervalMs * Math.pow(2, consecutiveErrorsRef.current),
            maxBackoffMs
          );
          if (
            hasPendingJobs(jobsRef.current) &&
            (typeof document === "undefined" ||
              document.visibilityState !== "hidden")
          ) {
            scheduleNextPollRef.current?.(backoffDelay);
          }
          return;
        }

        const etag = response.headers.get("ETag") ?? response.headers.get("etag");
        if (etag) {
          lastEtagRef.current = etag;
        }

        const payload = (await response.json()) as { data?: ExportJob[] };
        if (!mountedRef.current) return;

        const nextJobs = Array.isArray(payload.data) ? payload.data : [];
        consecutiveErrorsRef.current = 0;
        setJobs(nextJobs);
        jobsRef.current = nextJobs;
        setError(null);
        if (isInitial) setIsLoading(false);

        if (
          hasPendingJobs(nextJobs) &&
          (typeof document === "undefined" ||
            document.visibilityState !== "hidden")
        ) {
          scheduleNextPollRef.current?.(pollIntervalMs);
        } else {
          clearPollTimer();
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        if (!mountedRef.current) return;

        setError("Unable to load export jobs. Retrying automatically.");
        if (isInitial) setIsLoading(false);

        consecutiveErrorsRef.current += 1;
        const backoffDelay = Math.min(
          pollIntervalMs * Math.pow(2, consecutiveErrorsRef.current),
          maxBackoffMs
        );
        if (
          hasPendingJobs(jobsRef.current) &&
          (typeof document === "undefined" ||
            document.visibilityState !== "hidden")
        ) {
          scheduleNextPollRef.current?.(backoffDelay);
        }
      }
    },
    [
      clearPollTimer,
      hasPendingJobs,
      maxBackoffMs,
      pollIntervalMs,
      startRateLimitCooldown,
    ]
  );

  const scheduleNextPoll = useCallback(
    (delayMs: number) => {
      clearPollTimer();
      if (!mountedRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        void fetchJobs(false);
      }, delayMs);
    },
    [clearPollTimer, fetchJobs]
  );

  scheduleNextPollRef.current = scheduleNextPoll;

  useEffect(() => {
    mountedRef.current = true;
    void fetchJobs(true);

    const handleVisibilityChange = () => {
      if (!mountedRef.current) return;
      if (document.visibilityState === "hidden") {
        clearPollTimer();
      } else if (hasPendingJobs(jobsRef.current)) {
        void fetchJobs(false);
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      mountedRef.current = false;
      clearPollTimer();
      clearRateLimitTimer();
      abortControllerRef.current?.abort();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [clearPollTimer, clearRateLimitTimer, fetchJobs, hasPendingJobs]);

  const requestExport = useCallback(
    async (params: ExportRequestParams): Promise<ExportJob | null> => {
      if (!mountedRef.current) return null;
      setIsSubmitting(true);
      setSubmitError(null);

      const body: Record<string, string> = { format: params.format };
      if (params.startDate) body.startDate = params.startDate;
      if (params.endDate) body.endDate = params.endDate;

      try {
        const response = await fetch("/api/exports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!mountedRef.current) return null;

        if (!response.ok) {
          const retryAfter =
            response.status === 429
              ? parseRetryAfterSeconds(response.headers.get("Retry-After"))
              : undefined;
          const apiMessage = await extractApiErrorMessage(response);
          if (!mountedRef.current) return null;

          if (response.status === 429 && retryAfter) {
            startRateLimitCooldown(retryAfter);
          }
          setSubmitError(
            formatHttpErrorMessage(response.status, apiMessage, retryAfter)
          );
          return null;
        }

        const payload = (await response.json()) as { data?: ExportJob };
        if (!mountedRef.current) return null;

        const createdJob = payload.data ?? null;
        if (createdJob) {
          jobParamsRef.current.set(createdJob.id, { ...params });
          setJobs((prev) => {
            const next = [createdJob, ...prev.filter((j) => j.id !== createdJob.id)];
            jobsRef.current = next;
            return next;
          });
          if (
            createdJob.status === "pending" &&
            (typeof document === "undefined" ||
              document.visibilityState !== "hidden")
          ) {
            scheduleNextPoll(pollIntervalMs);
          }
        }
        return createdJob;
      } catch {
        if (!mountedRef.current) return null;
        setSubmitError("Network error while requesting export. Please try again.");
        return null;
      } finally {
        if (mountedRef.current) {
          setIsSubmitting(false);
        }
      }
    },
    [pollIntervalMs, scheduleNextPoll, startRateLimitCooldown]
  );

  const retryExport = useCallback(
    async (job: ExportJob): Promise<ExportJob | null> => {
      const savedParams = jobParamsRef.current.get(job.id);
      const inferredFormat: ExportFormat = job.fileName
        .toLowerCase()
        .endsWith(".json")
        ? "json"
        : "csv";
      const params: ExportRequestParams = savedParams ?? {
        format: inferredFormat,
      };
      return requestExport(params);
    },
    [requestExport]
  );

  const refresh = useCallback(async () => {
    await fetchJobs(false);
  }, [fetchJobs]);

  return {
    jobs,
    isLoading,
    isSubmitting,
    error,
    submitError,
    rateLimitSecondsLeft,
    isRateLimited: rateLimitSecondsLeft > 0,
    requestExport,
    retryExport,
    refresh,
  };
}
