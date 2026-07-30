/**
 * @jest-environment jsdom
 *
 * Focused tests for the cascade stagger animation added in #841.
 *
 * Scope:
 *  - `--cascade-index` CSS custom property is applied to each list item
 *    in the correct order.
 *  - The `.stream-cascade-item` wrapper is present for every stream row.
 *  - No cascade wrappers are rendered in the loading / empty / error states.
 *  - Reduced-motion: items are rendered with opacity/transform unset by the
 *    component (the CSS @media guard covers the browser side; here we verify
 *    the DOM structure is correct so the guard can fire).
 */

import { render, screen } from "@testing-library/react";
import { StreamsPageContent, mockStreams } from "./StreamsPageContent";

// Minimal StreamRow mock — we only need the article element to be present.
jest.mock("../components/StreamRow", () => ({
  StreamRow: ({
    stream,
    density,
  }: {
    stream: { id: string; recipient: string; rate: string; status: string };
    density?: string;
  }) => (
    <article data-testid="stream-row" data-density={density ?? "cozy"}>
      <span>{stream.recipient}</span>
      <span>{stream.rate}</span>
    </article>
  ),
}));

describe("Cascade animation — #841", () => {
  it("wraps each stream row in a .stream-cascade-item element", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} />);

    const wrappers = document.querySelectorAll(".stream-cascade-item");
    expect(wrappers).toHaveLength(mockStreams.length);
  });

  it("sets --cascade-index starting at 0 on the first item", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} />);

    const first = document.querySelector<HTMLElement>(".stream-cascade-item");
    expect(first).not.toBeNull();
    // Custom properties are stored as the exact string supplied inline.
    expect(first!.style.getPropertyValue("--cascade-index")).toBe("0");
  });

  it("increments --cascade-index for each subsequent item", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} />);

    const wrappers = document.querySelectorAll<HTMLElement>(".stream-cascade-item");
    wrappers.forEach((el, i) => {
      expect(el.style.getPropertyValue("--cascade-index")).toBe(String(i));
    });
  });

  it("does not render cascade wrappers in the loading state", () => {
    render(<StreamsPageContent state="loading" streams={[]} />);
    expect(document.querySelectorAll(".stream-cascade-item")).toHaveLength(0);
  });

  it("does not render cascade wrappers in the empty state", () => {
    render(<StreamsPageContent state="empty" streams={[]} />);
    expect(document.querySelectorAll(".stream-cascade-item")).toHaveLength(0);
  });

  it("does not render cascade wrappers in the error state", () => {
    render(<StreamsPageContent state="error" streams={[]} />);
    expect(document.querySelectorAll(".stream-cascade-item")).toHaveLength(0);
  });

  it("re-renders with correct indices when the stream list changes length", () => {
    const { rerender } = render(
      <StreamsPageContent state="populated" streams={mockStreams.slice(0, 2)} />,
    );

    let wrappers = document.querySelectorAll<HTMLElement>(".stream-cascade-item");
    expect(wrappers).toHaveLength(2);
    wrappers.forEach((el, i) =>
      expect(el.style.getPropertyValue("--cascade-index")).toBe(String(i)),
    );

    // Add a third stream
    rerender(<StreamsPageContent state="populated" streams={mockStreams} />);
    wrappers = document.querySelectorAll<HTMLElement>(".stream-cascade-item");
    expect(wrappers).toHaveLength(3);
    wrappers.forEach((el, i) =>
      expect(el.style.getPropertyValue("--cascade-index")).toBe(String(i)),
    );
  });

  it("filters cascade wrappers correctly when a tag is active", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} />);

    // Click the "onboarding" tag chip to filter down to 1 stream
    const onboardingBtn = screen.getByRole("button", { name: "onboarding" });
    onboardingBtn.click();

    const wrappers = document.querySelectorAll<HTMLElement>(".stream-cascade-item");
    // Only 1 stream has the "onboarding" tag (stream-kemi)
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]!.style.getPropertyValue("--cascade-index")).toBe("0");
  });

  it("respects compact density forwarded through the cascade wrapper", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} />);

    // Switch to compact via the radiogroup
    const compactRadio = screen.getByRole("radio", { name: /compact/i });
    compactRadio.click();

    // The stream-list should carry the compact modifier class
    const list = screen.getByLabelText(/streams list/i);
    expect(list).toHaveClass("stream-list--compact");

    // Every StreamRow mock receives density="compact"
    const rows = screen.getAllByTestId("stream-row");
    rows.forEach((row) => expect(row).toHaveAttribute("data-density", "compact"));
  });
});
