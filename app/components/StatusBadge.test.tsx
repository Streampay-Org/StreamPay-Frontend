import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each([
    ["draft", "Draft"],
    ["active", "Active"],
    ["paused", "Paused"],
    ["ended", "Ended"],
  ] as const)("renders the %s variant with an accessible label", (status, label) => {
    render(<StatusBadge status={status} />);

    const badge = screen.getByLabelText(`Stream status: ${label}`);

    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(label);
    expect(badge).toHaveClass(`status-badge--${status}`);
  });
});
