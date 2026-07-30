/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
import { EmptyIllustration } from "./EmptyIllustration";

describe("EmptyIllustration (v7 StreamRow-themed SVG)", () => {
  it("renders a root <svg> with a valid viewBox", () => {
    const { container } = render(<EmptyIllustration />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 400 300");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  });

  describe("accessibility", () => {
    it("is decorative by default (aria-hidden)", () => {
      const { container } = render(<EmptyIllustration />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("aria-hidden", "true");
    });

    it("announces a label via role=img when decorative=false", () => {
      const label = "Nothing in your streams list yet";
      const { container } = render(
        <EmptyIllustration decorative={false} label={label} />,
      );
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("role", "img");
      expect(svg).toHaveAttribute("aria-label", label);
    });
  });

  describe("v7 pattern tile echoes", () => {
    it("defines three SVG pattern <pattern> defs (stripes, dots, bars)", () => {
      const { container } = render(<EmptyIllustration />);
      const defs = container.querySelector("svg > defs");
      expect(defs).not.toBeNull();
      const patterns = defs!.querySelectorAll("pattern");
      // stripes + dots + bars + accentGlow (radialGradient) = 4 defs total
      expect(patterns.length).toBe(3);
    });

    it("renders three ghost-row rects (one per pattern echo)", () => {
      const { container } = render(<EmptyIllustration />);
      const svg = container.querySelector("svg")!;
      const rowPanels = svg.querySelectorAll('rect[rx="18"]');
      // 3 outer rounded cards + 3 inner rounded rect pattern containers
      expect(rowPanels.length).toBeGreaterThanOrEqual(3);
    });

    it("includes the accent " + " badge (invitation CTA hint)", () => {
      const { container } = render(<EmptyIllustration />);
      const svg = container.querySelector("svg")!;
      const plusLines = svg.querySelectorAll('line[stroke="var(--accent)"]');
      expect(plusLines.length).toBe(2); // horizontal + vertical of the plus glyph
    });

    it("uses design-token vars instead of hardcoded colors", () => {
      const { container } = render(<EmptyIllustration />);
      const svg = container.querySelector("svg")!;
      const svgMarkup = svg.outerHTML;
      // Design tokens referenced in the SVG (not literal hex)
      expect(svgMarkup).toMatch(/var\(--panel-elevated\)/);
      expect(svgMarkup).toMatch(/var\(--panel\)/);
      expect(svgMarkup).toMatch(/var\(--accent\)/);
      expect(svgMarkup).toMatch(/currentColor/);
    });
  });

  describe("sizing props", () => {
    it("applies the explicit size value instead of the default 100% fill", () => {
      const { container } = render(<EmptyIllustration size="180px" />);
      const svg = container.querySelector("svg")!;
      expect((svg as HTMLElement).style.width).not.toBe("100%");
      expect((svg as HTMLElement).style.width).toMatch(/180/);
    });

    it("forwards className to the svg element", () => {
      const { container } = render(
        <EmptyIllustration className="hero-illust" />,
      );
      expect(container.querySelector("svg")).toHaveClass("hero-illust");
    });
  });
});
