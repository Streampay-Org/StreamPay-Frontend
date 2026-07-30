/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { DateRangePicker } from "./DateRangePicker";

describe("DateRangePicker", () => {
  it("renders start and end date inputs with accessible labels", () => {
    render(<DateRangePicker label="Filter Range" />);

    expect(screen.getByText("Filter Range")).toBeInTheDocument();
    expect(screen.getByLabelText("Start date")).toBeInTheDocument();
    expect(screen.getByLabelText("End date")).toBeInTheDocument();
  });

  it("calls onChange when inputs change", () => {
    const handleChange = jest.fn();
    render(<DateRangePicker onChange={handleChange} />);

    const startInput = screen.getByLabelText("Start date");
    fireEvent.change(startInput, { target: { value: "2026-01-01" } });

    expect(handleChange).toHaveBeenCalledWith({
      startDate: "2026-01-01",
      endDate: "",
    });
  });
});