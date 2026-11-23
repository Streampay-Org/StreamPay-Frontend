import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StreamsPageContent } from "./StreamsPageContent";
import type { StreamRowData } from "../components/StreamRow";

const SORT_STORAGE_KEY = "streampay-streams-sort";

const sampleStreams: StreamRowData[] = [
  {
    id: "stream-zara",
    nextAction: "Pause",
    rate: "32 XLM / week",
    recipient: "Zara Studio",
    schedule: "Pays weekly",
    status: "active",
    startedAt: "2026-01-10T00:00:00Z",
    tags: ["design", "vendor"],
  },
  {
    id: "stream-ada",
    nextAction: "Start",
    rate: "120 XLM / month",
    recipient: "Ada Labs",
    schedule: "Draft stream",
    status: "draft",
    startedAt: "2026-03-15T00:00:00Z",
    tags: ["vendor"],
  },
  {
    id: "stream-kemi",
    nextAction: "Withdraw",
    rate: "18 XLM / day",
    recipient: "Kemi Support",
    schedule: "Ended yesterday",
    status: "ended",
    startedAt: "2026-02-01T00:00:00Z",
    tags: ["qa"],
  },
];

function getRenderedRecipients(): string[] {
  return screen
    .getAllByRole("row")
    .filter((row) => row.classList.contains("stream-row"))
    .map((row) => row.querySelector("h2")?.textContent ?? "");
}

describe("StreamsPageContent sort persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it("restores a valid stored sort value on mount", async () => {
    window.localStorage.setItem(SORT_STORAGE_KEY, "rate-asc");

    render(<StreamsPageContent streams={sampleStreams} />);

    const select = screen.getByLabelText("Sort streams") as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe("rate-asc");
    });

    expect(getRenderedRecipients()).toEqual([
      "Kemi Support",
      "Zara Studio",
      "Ada Labs",
    ]);
  });

  it("persists sort selection changes to localStorage", () => {
    render(<StreamsPageContent streams={sampleStreams} />);

    const select = screen.getByLabelText("Sort streams") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "recipient-desc" } });

    expect(select.value).toBe("recipient-desc");
    expect(window.localStorage.getItem(SORT_STORAGE_KEY)).toBe("recipient-desc");
    expect(getRenderedRecipients()).toEqual([
      "Zara Studio",
      "Kemi Support",
      "Ada Labs",
    ]);
  });

  it("ignores an invalid stored value and falls back to newest", async () => {
    window.localStorage.setItem(SORT_STORAGE_KEY, "corrupted-sort-value");

    render(<StreamsPageContent streams={sampleStreams} />);

    const select = screen.getByLabelText("Sort streams") as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe("newest");
    });

    expect(getRenderedRecipients()).toEqual([
      "Ada Labs",
      "Kemi Support",
      "Zara Studio",
    ]);
  });

  it("does not crash when localStorage throws on read or write", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError: storage blocked");
    });

    render(<StreamsPageContent streams={sampleStreams} />);

    const select = screen.getByLabelText("Sort streams") as HTMLSelectElement;
    expect(select.value).toBe("newest");

    expect(() => {
      fireEvent.change(select, { target: { value: "oldest" } });
    }).not.toThrow();

    expect(select.value).toBe("oldest");
    expect(getRenderedRecipients()).toEqual([
      "Zara Studio",
      "Kemi Support",
      "Ada Labs",
    ]);
  });

  it("respects initialSort and skips reading localStorage", () => {
    window.localStorage.setItem(SORT_STORAGE_KEY, "rate-desc");

    render(
      <StreamsPageContent streams={sampleStreams} initialSort="oldest" />,
    );

    const select = screen.getByLabelText("Sort streams") as HTMLSelectElement;
    expect(select.value).toBe("oldest");
    expect(getRenderedRecipients()).toEqual([
      "Zara Studio",
      "Kemi Support",
      "Ada Labs",
    ]);
  });

  it("applies sort after tag filtering without breaking density toggle", () => {
    render(
      <StreamsPageContent
        streams={sampleStreams}
        initialSort="recipient-asc"
        initialDensity="cozy"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "vendor" }));
    expect(getRenderedRecipients()).toEqual(["Ada Labs", "Zara Studio"]);

    const select = screen.getByLabelText("Sort streams") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "recipient-desc" } });
    expect(getRenderedRecipients()).toEqual(["Zara Studio", "Ada Labs"]);

    fireEvent.click(screen.getByRole("radio", { name: /compact/i }));
    expect(screen.getByRole("radio", { name: /compact/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
