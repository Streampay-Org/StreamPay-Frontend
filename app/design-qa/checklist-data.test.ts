import { CHECKLIST_SECTIONS, TOTAL_ITEMS } from "./checklist-data";

describe("design QA checklist data", () => {
  it("includes the microcopy review section", () => {
    const microcopy = CHECKLIST_SECTIONS.find((section) => section.id === "microcopy");

    expect(microcopy?.items).toHaveLength(6);
    expect(microcopy?.items.every((item) => item.annotation?.startsWith("Relevant pages: "))).toBe(
      true
    );
    expect(TOTAL_ITEMS).toBe(38);
    expect(microcopy).toMatchInlineSnapshot(`
{
  "description": "Copy should make stream setup, wallet actions, and on-chain status understandable without internal jargon.",
  "id": "microcopy",
  "items": [
    {
      "annotation": "Relevant pages: /, /streams, /activity, /settings",
      "id": "copy-1",
      "item": "Error messages are written in plain language, name what happened, and give the next useful action instead of exposing raw API, wallet, or contract errors.",
    },
    {
      "annotation": "Relevant pages: /, /streams, /settings",
      "id": "copy-2",
      "item": "Primary button copy starts with a clear verb and matches the action result, such as Create stream, Pause stream, Resume stream, Withdraw funds, or Save settings.",
    },
    {
      "annotation": "Relevant pages: /, /streams, /activity",
      "id": "copy-3",
      "item": "Empty states explain why the screen is empty and include one helpful next step or CTA instead of generic placeholder text.",
    },
    {
      "annotation": "Relevant pages: /, /streams, /activity",
      "id": "copy-4",
      "item": "Loading and pending states describe what is happening now, especially for wallet approval and on-chain transaction submission.",
    },
    {
      "annotation": "Relevant pages: /streams, /activity",
      "id": "copy-5",
      "item": "Status labels use consistent tense and naming across StreamRow, StatusBadge, activity entries, and confirmation dialogs.",
    },
    {
      "annotation": "Relevant pages: /, /streams, /activity",
      "id": "copy-6",
      "item": "Money amounts, recipients, and dates are repeated in confirmation and success copy so users can verify the exact stream outcome.",
    },
  ],
  "title": "Microcopy and Content Quality",
}
`);
  });
});
