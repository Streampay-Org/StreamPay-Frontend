/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { fireEvent, screen } = require("@testing-library/react") as any;
import { CommandPalette } from "./CommandPalette";
import { mockStreams } from "../streams/StreamsPageContent";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

function triggerOpen() {
  fireEvent.keyDown(document, { key: "k", metaKey: true });
}

function getSearchInput() {
  return screen.getByPlaceholderText(/search streams/i);
}

function triggerClose() {
  const input = screen.queryByPlaceholderText(/search streams/i);
  if (input) {
    fireEvent.keyDown(input, { key: "Escape" });
  }
}

describe("CommandPalette", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("is hidden by default", () => {
    render(<CommandPalette streams={mockStreams} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on Cmd+K and shows search input", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/search streams/i)
    ).toBeInTheDocument();
  });

  it("opens on Ctrl+K", () => {
    render(<CommandPalette streams={mockStreams} />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    triggerClose();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on backdrop click", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders all streams when query is empty", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    expect(screen.getByText(/ada creative studio/i)).toBeInTheDocument();
    expect(screen.getByText(/kemi onboarding support/i)).toBeInTheDocument();
    expect(screen.getByText(/yusuf qa partnership/i)).toBeInTheDocument();
  });

  it("filters streams by recipient name", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    const input = getSearchInput();
    fireEvent.change(input, { target: { value: "ada" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Ada Creative Studio");
  });

  it("filters streams by id", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    const input = screen.getByPlaceholderText(/search streams/i);
    fireEvent.change(input, { target: { value: "stream-kemi" } });

    expect(screen.queryByText(/ada creative studio/i)).not.toBeInTheDocument();
    expect(screen.getByText(/kemi onboarding support/i)).toBeInTheDocument();
  });

  it("shows empty state when no streams match", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    const input = screen.getByPlaceholderText(/search streams/i);
    fireEvent.change(input, { target: { value: "zzzzz" } });

    expect(screen.getByText(/no streams match/i)).toBeInTheDocument();
  });

  it("navigates to stream on Enter key", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    const input = screen.getByPlaceholderText(/search streams/i);
    fireEvent.change(input, { target: { value: "ada" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockPush).toHaveBeenCalledWith("/streams/stream-ada");
  });

  it("navigates to stream on click", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    fireEvent.mouseDown(screen.getByText(/ada creative studio/i));

    expect(mockPush).toHaveBeenCalledWith("/streams/stream-ada");
  });

  it("highlights matching text in results", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    const input = getSearchInput();
    fireEvent.change(input, { target: { value: "ada" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Ada Creative Studio");
    expect(options[0].innerHTML).toContain('style="font-weight: 700;"');
  });

  it("locks body scroll when open", () => {
    render(<CommandPalette streams={mockStreams} />);
    expect(document.body.style.overflow).toBe("");

    triggerOpen();
    expect(document.body.style.overflow).toBe("hidden");

    triggerClose();
    expect(document.body.style.overflow).toBe("");
  });

  it("shows keyboard shortcuts in footer", () => {
    render(<CommandPalette streams={mockStreams} />);
    triggerOpen();

    expect(screen.getByText(/navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/select/i)).toBeInTheDocument();
    expect(screen.getByText(/close/i)).toBeInTheDocument();
  });
});
