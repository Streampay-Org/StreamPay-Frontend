/**
 * @jest-environment jsdom
 */

import React from "react";
import { render } from "@testing-library/react";
const { screen, fireEvent } = require("@testing-library/react") as typeof import("@testing-library/react");

import { ImportPreview, type ConflictChoice } from "./ImportPreview";
import type { ClassifyResult } from "./importExport";

jest.mock("../components/Modal", () => ({
  Modal: ({
    isOpen,
    children,
    title,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    title: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

const SAMPLE_PREVIEW: ClassifyResult = {
  rows: [
    {
      status: "new",
      label: "New Alice",
      address: "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7",
      createdAt: "2026-04-01T00:00:00.000Z",
    },
    {
      status: "duplicate",
      label: "Dup Bob",
      address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE",
      createdAt: "2026-04-01T00:00:00.000Z",
    },
    {
      status: "conflict",
      label: "Conflict Carol",
      address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ7WGNB55IVJV",
      existingId: "existing-carol",
      createdAt: "2026-04-01T00:00:00.000Z",
    },
    {
      status: "invalid",
      label: "Bad Dave",
      address: "INVALID",
      reason: "Invalid address",
      createdAt: "2026-04-01T00:00:00.000Z",
    },
  ],
};

describe("ImportPreview", () => {
  it("renders nothing when preview is null", () => {
    render(
      <ImportPreview
        preview={null}
        conflictChoices={{}}
        onConflictChoiceChange={jest.fn()}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("displays row counts, details, and supports all three conflict choices", () => {
    const onConflictChoiceChange = jest.fn();
    const choices: Record<number, ConflictChoice> = { 2: "skip" };

    render(
      <ImportPreview
        preview={SAMPLE_PREVIEW}
        conflictChoices={choices}
        onConflictChoiceChange={onConflictChoiceChange}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(
      screen.getByText("1 new · 1 duplicate · 1 conflict · 1 invalid"),
    ).toBeInTheDocument();
    expect(screen.getByText("New Alice")).toBeInTheDocument();
    expect(screen.getByText("invalid: Invalid address")).toBeInTheDocument();

    const select = screen.getByLabelText("Conflict resolution for Conflict Carol");
    expect(select).toHaveValue("skip");

    fireEvent.change(select, { target: { value: "overwrite" } });
    expect(onConflictChoiceChange).toHaveBeenCalledWith(2, "overwrite");

    fireEvent.change(select, { target: { value: "keep-both" } });
    expect(onConflictChoiceChange).toHaveBeenCalledWith(2, "keep-both");

    fireEvent.change(select, { target: { value: "skip" } });
    expect(onConflictChoiceChange).toHaveBeenCalledWith(2, "skip");
  });

  it("calls onCancel and onConfirm from modal actions", () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();

    render(
      <ImportPreview
        preview={SAMPLE_PREVIEW}
        conflictChoices={{ 2: "skip" }}
        onConflictChoiceChange={jest.fn()}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
