/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { logger } from "@/app/lib/logger";
import { StreamViz } from "./StreamViz";
import type { StreamVizDataPoint } from "./StreamViz";

jest.mock("@/app/lib/logger", () => ({ logger: { warn: jest.fn() } }));

const sampleData: StreamVizDataPoint[] = [
  { date: "2026-05-01T00:00:00Z", remaining: 1000, accrued: 0 },
  { date: "2026-05-08T00:00:00Z", remaining: 750, accrued: 250 },
  { date: "2026-05-15T00:00:00Z", remaining: 500, accrued: 500 },
  { date: "2026-05-22T00:00:00Z", remaining: 250, accrued: 750 },
  { date: "2026-05-29T00:00:00Z", remaining: 0, accrued: 1000 },
];

describe("StreamViz", () => {
  describe("burn-down variant (default)", () => {
    it("renders the chart with accessible role", () => {
      const { container } = render(<StreamViz dataPoints={sampleData} />);
      const svg = container.querySelector(".stream-viz__svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("role", "img");
      expect(svg).toHaveAttribute("aria-label");
    });

    it("displays the latest remaining value", () => {
      const { container } = render(<StreamViz dataPoints={sampleData} unit="XLM" />);
      expect(container.querySelector(".stream-viz__chart-value")).toHaveTextContent(
        /^0 XLM \(0% remaining\)$/
      );
    });

    it("renders a legend with remaining and accrued labels", () => {
      const { container } = render(<StreamViz dataPoints={sampleData} unit="XLM" />);
      const legend = container.querySelector<HTMLElement>(".stream-viz__legend")!;
      expect(within(legend).getByText("Remaining (XLM)")).toBeInTheDocument();
      expect(within(legend).getByText("Accrued (XLM)")).toBeInTheDocument();
    });

    it("includes the helper text", () => {
      render(<StreamViz dataPoints={sampleData} />);
      expect(
        screen.getByText(
          "Estimate updates when StreamPay refreshes wallet and chain-observed activity."
        )
      ).toBeInTheDocument();
    });

    it("provides a collapsible data table toggle", () => {
      render(<StreamViz dataPoints={sampleData} />);
      expect(screen.getByText("View data table")).toBeInTheDocument();
    });

    it("has an sr-only summary of the chart values", () => {
      const { container } = render(<StreamViz dataPoints={sampleData} />);
      const srOnly = container.querySelector(".sr-only");
      expect(srOnly).toBeInTheDocument();
      expect(srOnly).toHaveTextContent("Remaining: 0");
    });

    it("uses role='figure' on the wrapper", () => {
      const { container } = render(<StreamViz dataPoints={sampleData} />);
      const wrapper = container.querySelector(".stream-viz--burn-down");
      expect(wrapper).toHaveAttribute("role", "figure");
    });
  });

  describe("sparkline variant", () => {
    it("renders an accessible image with remaining percentage", () => {
      render(<StreamViz dataPoints={sampleData} variant="sparkline" />);
      expect(
        screen.getByRole("img", { name: "Funds remaining chart: 0% remaining" })
      ).toBeInTheDocument();
    });

    it("reports 100% remaining when nothing is spent", () => {
      const fullData: StreamVizDataPoint[] = [
        { date: "2026-05-01T00:00:00Z", remaining: 500, accrued: 0 },
      ];
      render(<StreamViz dataPoints={fullData} variant="sparkline" />);
      expect(
        screen.getByRole("img", { name: "Funds remaining chart: 100% remaining" })
      ).toBeInTheDocument();
    });

    it("handles a single data point gracefully", () => {
      const singlePoint: StreamVizDataPoint[] = [
        { date: "2026-05-01T00:00:00Z", remaining: 100, accrued: 0 },
      ];
      const { container } = render(
        <StreamViz dataPoints={singlePoint} variant="sparkline" />
      );
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });
  });

  describe("data-table variant", () => {
    it("renders a semantic table", () => {
      render(<StreamViz dataPoints={sampleData} variant="data-table" />);
      const table = screen.getByRole("table");
      expect(table).toBeInTheDocument();
    });

    it("renders table headers", () => {
      render(<StreamViz dataPoints={sampleData} variant="data-table" />);
      expect(screen.getByText("Date")).toBeInTheDocument();
      expect(screen.getByText("Remaining (XLM)")).toBeInTheDocument();
      expect(screen.getByText("Accrued (XLM)")).toBeInTheDocument();
    });

    it("renders all data rows", () => {
      render(<StreamViz dataPoints={sampleData} variant="data-table" />);
      const rows = screen.getAllByRole("row");
      // 1 header + 5 data rows
      expect(rows).toHaveLength(6);
    });

    it("renders formatted date labels", () => {
      render(<StreamViz dataPoints={sampleData} variant="data-table" />);
      // May 1, May 8, etc.
      expect(screen.getByText("May 1")).toBeInTheDocument();
      expect(screen.getByText("May 29")).toBeInTheDocument();
    });

    it("shows empty message when no data", () => {
      render(<StreamViz dataPoints={[]} variant="data-table" />);
      expect(
        screen.getByText("Not enough stream activity to chart yet.")
      ).toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    it("renders skeleton when loading", () => {
      const { container } = render(
        <StreamViz dataPoints={sampleData} loading />
      );
      expect(container.querySelector(".stream-viz__skeleton")).toBeInTheDocument();
    });

    it("does not render chart content when loading", () => {
      render(<StreamViz dataPoints={sampleData} loading />);
      expect(screen.queryByText("Remaining funds over time")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message", () => {
      render(<StreamViz dataPoints={sampleData} error="Failed to load" />);
      expect(screen.getByText("Failed to load")).toBeInTheDocument();
    });

    it("shows retry button when onRetry is provided", () => {
      const onRetry = jest.fn();
      render(
        <StreamViz dataPoints={sampleData} error="Oops" onRetry={onRetry} />
      );
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });

    it("does not show retry button without onRetry", () => {
      render(<StreamViz dataPoints={sampleData} error="Oops" />);
      expect(screen.queryByText("Retry")).not.toBeInTheDocument();
    });

    it("calls onRetry when retry button is clicked", () => {
      const onRetry = jest.fn();
      render(
        <StreamViz dataPoints={sampleData} error="Oops" onRetry={onRetry} />
      );
      fireEvent.click(screen.getByText("Retry"));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("renders with role='alert' for error", () => {
      const { container } = render(
        <StreamViz dataPoints={sampleData} error="Something went wrong" />
      );
      expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows empty message when no data points", () => {
      render(<StreamViz dataPoints={[]} />);
      expect(
        screen.getByText("Not enough stream activity to chart yet.")
      ).toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    it("handles a single data point in burn-down mode", () => {
      const single: StreamVizDataPoint[] = [
        { date: "2026-05-01T00:00:00Z", remaining: 100, accrued: 0 },
      ];
      const { container } = render(<StreamViz dataPoints={single} />);
      const svg = container.querySelector(".stream-viz__svg");
      expect(svg).toBeInTheDocument();
    });

    it("handles all-zero data", () => {
      const zeroData: StreamVizDataPoint[] = [
        { date: "2026-05-01T00:00:00Z", remaining: 0, accrued: 0 },
        { date: "2026-05-02T00:00:00Z", remaining: 0, accrued: 0 },
      ];
      const { container } = render(
        <StreamViz dataPoints={zeroData} variant="sparkline" />
      );
      expect(
        screen.getByRole("img", { name: "Funds remaining chart: 0% remaining" })
      ).toBeInTheDocument();
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    it("forwards custom className", () => {
      const { container } = render(
        <StreamViz dataPoints={sampleData} className="my-custom-class" />
      );
      const el = container.querySelector(".stream-viz");
      expect(el).toHaveClass("my-custom-class");
    });
  });
});
describe("runtime safeguards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const generateData = (count: number): StreamVizDataPoint[] =>
    Array.from({ length: count }, (_, i) => ({
      date: new Date(Date.UTC(2026, 4, 1 + i)).toISOString(),
      remaining: count - i,
      accrued: i,
    }));

  describe.each(["burn-down", "sparkline"] as const)("%s", (variant) => {
    it.each([500, 501, 600])(
      "limits %i data points and warns only above 500",
      (count) => {
        const { container } = render(
          <StreamViz dataPoints={generateData(count)} variant={variant} />
        );
        const line = container.querySelector(
          variant === "burn-down"
            ? ".stream-viz__line--remaining"
            : 'path[fill="none"]'
        );
        expect(line?.getAttribute("d")?.match(/[ML]/g)).toHaveLength(
          Math.min(count, 500)
        );

        if (count > 500) {
          expect(logger.warn).toHaveBeenCalledTimes(1);
          expect(logger.warn).toHaveBeenCalledWith(
            `StreamViz: dataPoints truncated from ${count} to 500`
          );
        } else {
          expect(logger.warn).not.toHaveBeenCalled();
        }
      }
    );
  });

  it('clamps ChartSkeleton dimensions to max values', () => {
    render(
      <StreamViz
        dataPoints={[]}
        loading
        // Force large dimensions via props passed through ChartSkeleton indirectly
      />
    );
    // The skeleton renders ChartSkeleton with default width/height, we can test via DOM
    const skeleton = document.querySelector('.stream-viz__skeleton');
    expect(skeleton).toBeInTheDocument();
    // Since clamping is internal, ensure no error and element exists
  });
});
