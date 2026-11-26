"use client";

import React from "react";
import { Modal } from "../components/Modal";
import type { ClassifyResult, ImportRowStatus } from "./importExport";

export type ConflictChoice = "skip" | "overwrite" | "keep-both";

export interface ImportPreviewProps {
  preview: ClassifyResult | null;
  conflictChoices: Record<number, ConflictChoice>;
  onConflictChoiceChange: (index: number, choice: ConflictChoice) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ImportPreview({
  preview,
  conflictChoices,
  onConflictChoiceChange,
  onCancel,
  onConfirm,
}: ImportPreviewProps) {
  const counts = preview
    ? preview.rows.reduce<Record<ImportRowStatus, number>>(
        (acc, r) => {
          acc[r.status] += 1;
          return acc;
        },
        { new: 0, duplicate: 0, conflict: 0, invalid: 0 },
      )
    : null;

  return (
    <Modal
      isOpen={preview !== null}
      onClose={onCancel}
      title="Import preview"
    >
      {preview && counts && (
        <div>
          <p
            aria-live="polite"
            style={{ fontSize: "0.85rem", color: "var(--muted-foreground)" }}
          >
            {counts.new} new · {counts.duplicate} duplicate ·{" "}
            {counts.conflict} conflict · {counts.invalid} invalid
          </p>
          <div className="import-preview">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: "left" }}>Label</th>
                  <th scope="col" style={{ textAlign: "left" }}>Address</th>
                  <th scope="col" style={{ textAlign: "left" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i}>
                    <td>{row.label || "—"}</td>
                    <td style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                      {row.address || "—"}
                    </td>
                    <td>
                      {row.status}
                      {row.reason ? `: ${row.reason}` : ""}
                      {row.needsResolution ? " (needs resolution)" : ""}
                      {row.status === "conflict" && (
                        <select
                          aria-label={`Conflict resolution for ${row.label}`}
                          value={conflictChoices[i] ?? "skip"}
                          onChange={(e) =>
                            onConflictChoiceChange(
                              i,
                              e.target.value as ConflictChoice,
                            )
                          }
                        >
                          <option value="skip">Skip</option>
                          <option value="overwrite">Overwrite</option>
                          <option value="keep-both">Keep both</option>
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              justifyContent: "flex-end",
              marginTop: "1rem",
            }}
          >
            <button
              type="button"
              className="button button--secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={onConfirm}
            >
              Import
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
