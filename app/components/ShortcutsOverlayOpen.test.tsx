/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import ShortcutsOverlayOpen from "./ShortcutsOverlayOpen";

describe("ShortcutsOverlayOpen", () => {
  it("mounts the shortcuts dialog open", () => {
    render(<ShortcutsOverlayOpen />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
