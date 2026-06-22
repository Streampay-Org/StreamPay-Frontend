"use client";

import { useState, useCallback, type FormEvent, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { SUPPORTED_SCHEDULES } from "@/app/lib/stream-validation";
import { isValidStellarPublicKey } from "@/app/lib/wallet-link";
import { post } from "@/lib/apiClient";
import type { StreamV2 } from "@/app/lib/api-version";
import type { StreamPayError } from "@/app/lib/errors/types";
import { ErrorBanner } from "./ErrorBanner";

interface FieldErrors {
  recipient?: string;
  rate?: string;
  schedule?: string;
  token?: string;
}

interface FormFields {
  recipient: string;
  rate: string;
  schedule: string;
  token: string;
}

function validateField(name: keyof FieldErrors, value: string): string | null {
  switch (name) {
    case "recipient": {
      if (!value.trim()) return "Recipient is required.";
      if (!isValidStellarPublicKey(value.trim()))
        return "Must be a valid Stellar public key (56 chars, starts with G).";
      return null;
    }
    case "rate": {
      if (!value.trim()) return "Rate is required.";
      if (!/^\d+(?:\.\d+)?$/.test(value.trim()))
        return "Must be a positive decimal number.";
      if (Number(value) <= 0) return "Must be greater than zero.";
      const frac = value.trim().split(".")[1] ?? "";
      if (frac.length > 7) return "At most 7 decimal places.";
      return null;
    }
    case "schedule": {
      if (!value) return "Schedule is required.";
      if (!SUPPORTED_SCHEDULES.includes(value as (typeof SUPPORTED_SCHEDULES)[number]))
        return `Must be one of: ${SUPPORTED_SCHEDULES.join(", ")}.`;
      return null;
    }
    case "token": {
      if (value && typeof value !== "string") return "Must be a string if provided.";
      return null;
    }
    default:
      return null;
  }
}

function extractServerFieldErrors(
  error: StreamPayError,
): Record<string, string> | undefined {
  if (error.meta?.fieldErrors) {
    return error.meta.fieldErrors as Record<string, string>;
  }

  if (error.meta) {
    const fieldErrors: Record<string, string> = {};
    for (const key of Object.keys(error.meta)) {
      const val = (error.meta as Record<string, unknown>)[key];
      if (
        val &&
        typeof val === "object" &&
        !Array.isArray(val) &&
        "field" in val &&
        "message" in val &&
        typeof (val as { field: string }).field === "string"
      ) {
        const entry = val as { field: string; message: string };
        if (!fieldErrors[entry.field]) {
          fieldErrors[entry.field] = entry.message;
        }
      }
    }
    if (Object.keys(fieldErrors).length > 0) return fieldErrors;
  }

  if (
    error.debug?.rawResponse?.error?.details &&
    Array.isArray(error.debug.rawResponse.error.details)
  ) {
    const fieldErrors: Record<string, string> = {};
    for (const d of error.debug.rawResponse.error.details) {
      if (d.field && d.message && !fieldErrors[d.field]) {
        fieldErrors[d.field] = d.message;
      }
    }
    if (Object.keys(fieldErrors).length > 0) return fieldErrors;
  }

  return undefined;
}

export function StreamForm() {
  const router = useRouter();
  const [fields, setFields] = useState<FormFields>({
    recipient: "",
    rate: "",
    schedule: "",
    token: "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<StreamPayError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const setField = useCallback(
    (name: keyof FormFields) =>
      (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setFields((prev) => ({ ...prev, [name]: e.target.value }));
      },
    [],
  );

  const validateAll = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};
    for (const field of ["recipient", "rate", "schedule", "token"] as const) {
      const err = validateField(field, fields[field]);
      if (err) errors[field] = err;
    }
    return errors;
  }, [fields]);

  const handleBlur = useCallback(
    (field: keyof FieldErrors) => {
      const err = validateField(field, fields[field]);
      setFieldErrors((prev) => ({ ...prev, [field]: err ?? undefined }));
    },
    [fields],
  );

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setServerError(null);

      const errors = validateAll();
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) return;

      setIsSubmitting(true);

      try {
        const body: Record<string, string> = {
          recipient: fields.recipient.trim(),
          rate: fields.rate.trim(),
          schedule: fields.schedule,
        };
        if (fields.token.trim()) {
          body.token = fields.token.trim();
        }

        const result = await post<StreamV2>("/api/v2/streams", body);

        router.push(`/streams/${result.id}`);
      } catch (err: unknown) {
        const streamPayError = err as StreamPayError;

        if (
          streamPayError.status === 422 ||
          streamPayError.code === "VALIDATION_ERROR" ||
          streamPayError.code === "UNPROCESSABLE_ENTITY"
        ) {
          const serverFieldErrors = extractServerFieldErrors(streamPayError);
          if (serverFieldErrors) {
            setFieldErrors((prev) => ({ ...prev, ...serverFieldErrors }));
          } else {
            setServerError(streamPayError);
          }
        } else {
          setServerError(streamPayError);
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [fields, validateAll, router],
  );

  return (
    <div className="stream-form">
      {serverError && (
        <ErrorBanner
          error={serverError}
          onDismiss={() => setServerError(null)}
        />
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="stream-form__field">
          <label htmlFor="recipient">Recipient</label>
          <input
            id="recipient"
            type="text"
            value={fields.recipient}
            onChange={setField("recipient")}
            onBlur={() => handleBlur("recipient")}
            aria-describedby={fieldErrors.recipient ? "recipient-error" : undefined}
            aria-invalid={!!fieldErrors.recipient}
            disabled={isSubmitting}
            placeholder="G..."
          />
          {fieldErrors.recipient && (
            <p id="recipient-error" className="stream-form__error" role="alert">
              {fieldErrors.recipient}
            </p>
          )}
        </div>

        <div className="stream-form__field">
          <label htmlFor="rate">Rate</label>
          <input
            id="rate"
            type="text"
            inputMode="decimal"
            value={fields.rate}
            onChange={setField("rate")}
            onBlur={() => handleBlur("rate")}
            aria-describedby={fieldErrors.rate ? "rate-error" : undefined}
            aria-invalid={!!fieldErrors.rate}
            disabled={isSubmitting}
            placeholder="e.g. 100"
          />
          {fieldErrors.rate && (
            <p id="rate-error" className="stream-form__error" role="alert">
              {fieldErrors.rate}
            </p>
          )}
        </div>

        <div className="stream-form__field">
          <label htmlFor="schedule">Schedule</label>
          <select
            id="schedule"
            value={fields.schedule}
            onChange={setField("schedule")}
            onBlur={() => handleBlur("schedule")}
            aria-describedby={fieldErrors.schedule ? "schedule-error" : undefined}
            aria-invalid={!!fieldErrors.schedule}
            disabled={isSubmitting}
          >
            <option value="">Select a schedule</option>
            {SUPPORTED_SCHEDULES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {fieldErrors.schedule && (
            <p id="schedule-error" className="stream-form__error" role="alert">
              {fieldErrors.schedule}
            </p>
          )}
        </div>

        <div className="stream-form__field">
          <label htmlFor="token">Token (optional)</label>
          <input
            id="token"
            type="text"
            value={fields.token}
            onChange={setField("token")}
            onBlur={() => handleBlur("token")}
            aria-describedby={fieldErrors.token ? "token-error" : undefined}
            aria-invalid={!!fieldErrors.token}
            disabled={isSubmitting}
            placeholder="XLM"
          />
          {fieldErrors.token && (
            <p id="token-error" className="stream-form__error" role="alert">
              {fieldErrors.token}
            </p>
          )}
        </div>

        <button
          type="submit"
          className={`button button--primary${isSubmitting ? " button--busy" : ""}`}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Creating Stream..." : "Create Stream"}
        </button>
      </form>
    </div>
  );
}
