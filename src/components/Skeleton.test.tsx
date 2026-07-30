/**
 * @jest-environment jsdom
 */

import React from "react";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Skeleton } from "./Skeleton";

describe("Skeleton component", () => {
  // ── Baseline rendering ──────────────────────────────────────────────────

  it("renders with default props (100% wide, 1rem tall)", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass("skeleton");
    expect(el).toHaveStyle({ width: "100%", height: "1rem" });
  });

  it("is aria-hidden to keep it out of the AT tree", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a <div> element", () => {
    const { container } = render(<Skeleton />);
    expect((container.firstChild as HTMLElement).tagName.toLowerCase()).toBe("div");
  });

  // ── Custom dimensions ───────────────────────────────────────────────────

  it("applies custom width and height as CSS strings", () => {
    const { container } = render(<Skeleton width="50%" height="2rem" />);
    expect(container.firstChild).toHaveStyle({ width: "50%", height: "2rem" });
  });

  it("converts numeric width to px string", () => {
    const { container } = render(<Skeleton width={100} height={50} />);
    expect(container.firstChild).toHaveStyle({ width: "100px", height: "50px" });
  });

  // ── Circle mode ─────────────────────────────────────────────────────────

  it("applies borderRadius 50% when circle=true", () => {
    const { container } = render(<Skeleton circle />);
    expect(container.firstChild).toHaveStyle({ borderRadius: "50%" });
  });

  it("does not apply borderRadius when circle is false (default)", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    // borderRadius is not set as an inline style
    expect(el.style.borderRadius).toBe("");
  });

  // ── className passthrough ───────────────────────────────────────────────

  it("appends custom className alongside base .skeleton class", () => {
    const { container } = render(<Skeleton className="my-extra-class" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass("skeleton");
    expect(el).toHaveClass("my-extra-class");
  });

  // ── Variant support ─────────────────────────────────────────────────────

  const variants: Array<import("./Skeleton").SkeletonVariant> = [
    "title", "text", "badge", "label", "value", "button",
  ];

  variants.forEach((variant) => {
    it(`applies variant class "skeleton--${variant}"`, () => {
      const { container } = render(<Skeleton variant={variant} />);
      const el = container.firstChild as HTMLElement;
      expect(el).toHaveClass("skeleton");
      expect(el).toHaveClass(`skeleton--${variant}`);
    });

    it(`does not set inline width/height when variant="${variant}" is used without overrides`, () => {
      const { container } = render(<Skeleton variant={variant} />);
      const el = container.firstChild as HTMLElement;
      expect(el.style.width).toBe("");
      expect(el.style.height).toBe("");
    });
  });

  it("allows explicit width/height to override variant defaults", () => {
    const { container } = render(<Skeleton variant="button" width="200px" height="3rem" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass("skeleton--button");
    expect(el).toHaveStyle({ width: "200px", height: "3rem" });
  });

  it("can combine variant with circle", () => {
    const { container } = render(<Skeleton variant="badge" circle />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass("skeleton--badge");
    expect(el).toHaveStyle({ borderRadius: "50%" });
  });

  // ── Multiple instances (skeleton layout) ───────────────────────────────

  it("renders multiple skeleton elements in a layout", () => {
    const { container } = render(
      <div>
        <Skeleton variant="title" />
        <Skeleton variant="text" />
        <Skeleton variant="button" />
      </div>
    );
    const skeletons = container.querySelectorAll(".skeleton");
    expect(skeletons).toHaveLength(3);
    expect(skeletons[0]).toHaveClass("skeleton--title");
    expect(skeletons[1]).toHaveClass("skeleton--text");
    expect(skeletons[2]).toHaveClass("skeleton--button");
  });
});
