/**
 * @jest-environment jsdom
 */
import React from "react";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RecipientAvatar } from "./RecipientAvatar";
import { getRecipientIdenticon } from "../lib/identicon";

describe("RecipientAvatar", () => {
  it("renders the recipient's initials", () => {
    const { getByText } = render(<RecipientAvatar recipient="Ada Creative Studio" />);
    expect(getByText("AC")).toBeInTheDocument();
  });

  it("is hidden from assistive technology (identity is shown as text elsewhere)", () => {
    const { container } = render(<RecipientAvatar recipient="Ada Creative Studio" />);
    expect(container.querySelector(".recipient-avatar")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the same recipient with the same colour every time", () => {
    const { container: first } = render(<RecipientAvatar recipient="Kemi Onboarding Support" />);
    const { container: second } = render(<RecipientAvatar recipient="Kemi Onboarding Support" />);
    const firstIdx = (first.querySelector(".recipient-avatar") as HTMLElement).dataset.paletteIndex;
    const secondIdx = (second.querySelector(".recipient-avatar") as HTMLElement).dataset.paletteIndex;
    expect(firstIdx).toBe(secondIdx);
  });

  it("uses the palette index computed by the identicon util", () => {
    const { paletteIndex } = getRecipientIdenticon("Yusuf QA Partnership");
    const { container } = render(<RecipientAvatar recipient="Yusuf QA Partnership" />);
    const badge = container.querySelector(".recipient-avatar") as HTMLElement;
    expect(badge.dataset.paletteIndex).toBe(String(paletteIndex));
  });

  it("respects a custom size", () => {
    const { container } = render(<RecipientAvatar recipient="Ada" size={48} />);
    const badge = container.querySelector(".recipient-avatar") as HTMLElement;
    expect(badge.style.width).toBe("48px");
    expect(badge.style.height).toBe("48px");
  });

  it("falls back to '?' for an empty recipient rather than rendering nothing", () => {
    const { getByText } = render(<RecipientAvatar recipient="" />);
    expect(getByText("?")).toBeInTheDocument();
  });
});
