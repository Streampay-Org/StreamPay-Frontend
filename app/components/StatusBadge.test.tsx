/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { StatusBadge } from "./StatusBadge";
import type { StreamStatus } from "@/app/types/openapi";

const ALL_STATUSES: readonly StreamStatus[] = [
  "draft",
  "active",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
] as const;

const STATUS_LABELS: Record<StreamStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  ended: "Ended",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
};

describe("StatusBadge", () => {
  it.each(ALL_STATUSES.map((s) => [s, STATUS_LABELS[s]] as const))(
    "renders the %s variant with an accessible label",
    (status, label) => {
      render(<StatusBadge status={status} />);

      const badge = screen.getByLabelText(`Stream status: ${label}`);

      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent(label);
    }
  );

  it.each(ALL_STATUSES)(
    "renders a decorative shape icon for %s (color is not the only differentiator)",
    (status) => {
      const { container } = render(<StatusBadge status={status} />);
      const icon = container.querySelector(`.status-icon--${status}`);

      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect((icon?.textContent ?? "").length).toBeGreaterThan(0);
    }
  );

  it("uses distinct glyphs across statuses", () => {
    const glyphs = ALL_STATUSES.map((status) => {
      const { container } = render(<StatusBadge status={status} />);
      return container.querySelector(`.status-icon--${status}`)?.textContent;
    });
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  describe("color-blind safe pattern classes (v7)", () => {
    it.each(ALL_STATUSES)(
      "applies the cb-pattern base + status pattern class for %s",
      (status) => {
        const { container } = render(<StatusBadge status={status} />);
        const badge = container.querySelector(".status-badge");

        expect(badge).toHaveClass("cb-pattern");
      }
    );

    it("applies cb-pattern--active for active streams", () => {
      const { container } = render(<StatusBadge status="active" />);
      expect(container.querySelector(".status-badge")).toHaveClass("cb-pattern--active");
    });

    it("applies cb-pattern--draft for draft streams", () => {
      const { container } = render(<StatusBadge status="draft" />);
      expect(container.querySelector(".status-badge")).toHaveClass("cb-pattern--draft");
    });

    it("applies cb-pattern--paused for paused streams", () => {
      const { container } = render(<StatusBadge status="paused" />);
      expect(container.querySelector(".status-badge")).toHaveClass("cb-pattern--paused");
    });

    it("applies cb-pattern--ended for ended streams", () => {
      const { container } = render(<StatusBadge status="ended" />);
      expect(container.querySelector(".status-badge")).toHaveClass("cb-pattern--ended");
    });

    it("applies cb-pattern--ended for withdrawn streams (same terminal texture)", () => {
      const { container } = render(<StatusBadge status="withdrawn" />);
      expect(container.querySelector(".status-badge")).toHaveClass("cb-pattern--ended");
    });

    it("applies cb-pattern--cancelled for cancelled streams", () => {
      const { container } = render(<StatusBadge status="cancelled" />);
      expect(container.querySelector(".status-badge")).toHaveClass("cb-pattern--cancelled");
    });

    it("forwards an additional className prop when provided", () => {
      const { container } = render(
        <StatusBadge status="active" className="custom-badge-extra" />
      );
      expect(container.querySelector(".status-badge")).toHaveClass("custom-badge-extra");
    });
  });
});
