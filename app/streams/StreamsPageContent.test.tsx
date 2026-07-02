/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StreamsPageContent } from "./StreamsPageContent";

const STORAGE_KEY = "streampay.density";

describe("StreamsPageContent density toggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to comfortable when no localStorage value exists", () => {
    render(<StreamsPageContent state="populated" />);

    const compactSwitch = screen.getByRole("switch", { name: /streams list density/i });
    expect(compactSwitch).toHaveAttribute("aria-checked", "false");

    // Should not mark rows compact.
    expect(document.querySelectorAll(".stream-row--compact").length).toBe(0);
  });

  it("uses compact mode when localStorage is set", () => {
    window.localStorage.setItem(STORAGE_KEY, "compact");

    render(<StreamsPageContent state="populated" />);

    const compactSwitch = screen.getByRole("switch", { name: /streams list density/i });
    expect(compactSwitch).toHaveAttribute("aria-checked", "true");

    expect(document.querySelectorAll(".stream-row--compact").length).toBeGreaterThan(0);
  });

  it("toggle persists per device via localStorage", async () => {
    const user = userEvent.setup();
    render(<StreamsPageContent state="populated" />);

    const compactSwitch = screen.getByRole("switch", { name: /streams list density/i });
    await user.click(compactSwitch);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("compact");
    expect(compactSwitch).toHaveAttribute("aria-checked", "true");
  });
});

