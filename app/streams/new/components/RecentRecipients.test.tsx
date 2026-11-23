/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import { RecentRecipients } from "./RecentRecipients";
import { encodeStellarPublicKey } from "../../../lib/stellar-address";
import {
  addRecentRecipient,
  clearRecentRecipients,
  getRecentRecipients,
} from "../../../state/recentRecipients";

const ADDR_A = encodeStellarPublicKey(new Uint8Array(32).fill(1));
const ADDR_B = encodeStellarPublicKey(new Uint8Array(32).fill(2));
const ADDR_C = encodeStellarPublicKey(new Uint8Array(32).fill(3));
const ADDR_D = encodeStellarPublicKey(new Uint8Array(32).fill(4));
const ADDR_E = encodeStellarPublicKey(new Uint8Array(32).fill(5));
const ADDR_F = encodeStellarPublicKey(new Uint8Array(32).fill(6));
const ADDR_G = encodeStellarPublicKey(new Uint8Array(32).fill(7));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  clearRecentRecipients();
});

describe("recentRecipients state module", () => {
  it("returns empty array when localStorage is empty", () => {
    expect(getRecentRecipients()).toEqual([]);
  });

  it("adds a recipient and retrieves it", () => {
    addRecentRecipient(ADDR_A);
    const result = getRecentRecipients();
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe(ADDR_A);
    expect(result[0].addedAt).toBeLessThanOrEqual(Date.now());
  });

  it("prepends new entries so the most recent is first", () => {
    addRecentRecipient(ADDR_A);
    addRecentRecipient(ADDR_B);
    const result = getRecentRecipients();
    expect(result[0].address).toBe(ADDR_B);
    expect(result[1].address).toBe(ADDR_A);
  });

  it("deduplicates: re-adding an existing address moves it to front", () => {
    addRecentRecipient(ADDR_A);
    addRecentRecipient(ADDR_B);
    addRecentRecipient(ADDR_A);
    const result = getRecentRecipients();
    expect(result).toHaveLength(2);
    expect(result[0].address).toBe(ADDR_A);
    expect(result[1].address).toBe(ADDR_B);
  });

  it("caps the list at 6 entries", () => {
    [ADDR_A, ADDR_B, ADDR_C, ADDR_D, ADDR_E, ADDR_F, ADDR_G].forEach(
      addRecentRecipient
    );
    const result = getRecentRecipients();
    expect(result).toHaveLength(6);
    expect(result[0].address).toBe(ADDR_G);
  });

  it("ignores empty and whitespace-only addresses", () => {
    addRecentRecipient("");
    addRecentRecipient("   ");
    expect(getRecentRecipients()).toHaveLength(0);
  });

  it("trims whitespace from addresses before storing", () => {
    addRecentRecipient(`  ${ADDR_A}  `);
    const result = getRecentRecipients();
    expect(result[0].address).toBe(ADDR_A);
  });

  it("clearRecentRecipients removes all entries", () => {
    addRecentRecipient(ADDR_A);
    clearRecentRecipients();
    expect(getRecentRecipients()).toHaveLength(0);
  });
});

describe("RecentRecipients component", () => {
  describe("empty state (no recent recipients)", () => {
    it("renders a themed empty state instead of nothing", () => {
      render(<RecentRecipients onSelect={jest.fn()} />);

      expect(screen.getByText("Recent recipients")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "No recent recipients yet" })
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Addresses you send streams to will appear here for quick reuse next time."
        )
      ).toBeInTheDocument();
    });

    it("uses the generic EmptyState variant (no illustration) in this compact context", () => {
      const { container } = render(<RecentRecipients onSelect={jest.fn()} />);

      expect(container.querySelector(".empty-state__illustration")).toBeNull();
      expect(container.querySelector("svg")).toBeNull();
    });

    it("applies the compact recent-recipients-empty class alongside any forwarded className", () => {
      const { container } = render(
        <RecentRecipients onSelect={jest.fn()} className="my-extra-class" />
      );

      const section = container.querySelector("section.empty-state")!;
      expect(section).toHaveClass("recent-recipients-empty");
      expect(section).toHaveClass("my-extra-class");
    });

    it("focuses the recipient address input when the CTA is activated", () => {
      render(
        <div>
          <RecentRecipients onSelect={jest.fn()} />
          <input id="recipient" />
        </div>
      );

      const input = document.getElementById("recipient") as HTMLInputElement;
      expect(input).not.toHaveFocus();

      fireEvent.click(
        screen.getByRole("button", { name: "Enter an address" })
      );

      expect(input).toHaveFocus();
    });

    it("does not throw when the recipient input is not present in the DOM", () => {
      render(<RecentRecipients onSelect={jest.fn()} />);

      expect(() =>
        fireEvent.click(
          screen.getByRole("button", { name: "Enter an address" })
        )
      ).not.toThrow();
    });
  });

  it("renders a pill for each recent recipient", async () => {
    addRecentRecipient(ADDR_A);
    addRecentRecipient(ADDR_B);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
  });

  it("displays truncated addresses in pill labels", async () => {
    addRecentRecipient(ADDR_A);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    const pill = screen.getByRole("button");
    expect(pill.textContent).toBe(`${ADDR_A.slice(0, 6)}…${ADDR_A.slice(-6)}`);
  });

  it("exposes the full address in aria-label for screen readers", async () => {
    addRecentRecipient(ADDR_A);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    expect(
      screen.getByRole("button", {
        name: `Use recent recipient ${ADDR_A}`,
      })
    ).toBeInTheDocument();
  });

  it("exposes the full address as title tooltip", async () => {
    addRecentRecipient(ADDR_A);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    expect(screen.getByRole("button")).toHaveAttribute("title", ADDR_A);
  });

  it("calls onSelect with the full address when a pill is clicked", async () => {
    const onSelect = jest.fn();
    addRecentRecipient(ADDR_A);

    await act(async () => {
      render(<RecentRecipients onSelect={onSelect} />);
    });

    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ADDR_A);
  });

  it("renders pills in most-recent-first order", async () => {
    addRecentRecipient(ADDR_A);
    addRecentRecipient(ADDR_B);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAttribute(
      "aria-label",
      `Use recent recipient ${ADDR_B}`
    );
    expect(buttons[1]).toHaveAttribute(
      "aria-label",
      `Use recent recipient ${ADDR_A}`
    );
  });

  it("renders at most 6 pills even when more addresses are stored", async () => {
    [ADDR_A, ADDR_B, ADDR_C, ADDR_D, ADDR_E, ADDR_F, ADDR_G].forEach(
      addRecentRecipient
    );

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    expect(screen.getAllByRole("button")).toHaveLength(6);
  });

  it("renders the 'Recent' label when recipients exist", async () => {
    addRecentRecipient(ADDR_A);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    expect(screen.getByText("Recent")).toBeInTheDocument();
  });

  it("all pills are type=button to avoid accidental form submission", async () => {
    addRecentRecipient(ADDR_A);
    addRecentRecipient(ADDR_B);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    screen.getAllByRole("button").forEach((btn) => {
      expect(btn).toHaveAttribute("type", "button");
    });
  });

  it("applies an extra className to the wrapper when provided", async () => {
    addRecentRecipient(ADDR_A);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <RecentRecipients onSelect={jest.fn()} className="my-extra-class" />
      ));
    });

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass("recent-recipients");
    expect(wrapper).toHaveClass("my-extra-class");
  });

  it("has aria-label on the wrapper for landmark context", async () => {
    addRecentRecipient(ADDR_A);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<RecentRecipients onSelect={jest.fn()} />));
    });

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveAttribute(
      "aria-label",
      "Recently used recipients"
    );
  });

  it("renders a list element for the rail", async () => {
    addRecentRecipient(ADDR_A);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    expect(screen.getByRole("list")).toBeInTheDocument();
  });

  it("each pill item is a list item inside the rail", async () => {
    addRecentRecipient(ADDR_A);
    addRecentRecipient(ADDR_B);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("ignores invalid short addresses and keeps the empty state", async () => {
    const shortAddr = "GABC123";
    addRecentRecipient(shortAddr);

    await act(async () => {
      render(<RecentRecipients onSelect={jest.fn()} />);
    });

    expect(
      screen.getByRole("heading", { name: "No recent recipients yet" })
    ).toBeInTheDocument();
  });
});
