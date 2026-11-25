import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { ReceiptThemeEditor } from "./ReceiptThemeEditor";

expect.extend(toHaveNoViolations);

const theme = { accentColor: "#abc", logoUrl: "https://images.example.test/mark.png", message: "Thanks <Ada> 💙" };
const originalFetch = global.fetch;

function reply(theme: object | null, canEdit = true) {
  return { ok: true, json: async () => ({ data: { theme, canEdit, logoAllowedHosts: "images.example.test" } }) };
}

async function openEditor(currentTheme: object | null = null, canEdit = true) {
  const fetchMock = jest.fn().mockResolvedValueOnce(reply(currentTheme, canEdit));
  global.fetch = fetchMock;
  const view = render(
    <main>
      <h1>Settings</h1>
      <h2>Receipt themes</h2>
      <ReceiptThemeEditor confirmNavigation={async () => true} onDirtyChange={jest.fn()} />
    </main>,
  );
  fireEvent.change(screen.getByLabelText("Organization ID"), { target: { value: "org-acme" } });
  fireEvent.change(screen.getByLabelText("Wallet address"), { target: { value: "owner-wallet" } });
  fireEvent.click(screen.getByRole("button", { name: "Load receipt theme" }));
  await screen.findByLabelText("Accent colour");
  return { ...view, fetchMock };
}

afterEach(() => { global.fetch = originalFetch; });

it("shows field errors and blocks invalid saves", async () => {
  const { fetchMock } = await openEditor();
  fireEvent.change(screen.getByLabelText("Accent colour"), { target: { value: "blue" } });
  fireEvent.change(screen.getByLabelText("Logo URL"), { target: { value: "http://images.example.test/a" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "a".repeat(141) } });
  expect(screen.getByText(/enter a 3- or 6-digit hex colour/i)).toBeVisible();
  expect(screen.getByText(/enter an HTTPS image URL/i)).toBeVisible();
  expect(screen.getByText(/enter a message of at most 140 characters/i)).toBeVisible();
  expect(screen.getByRole("button", { name: "Save theme" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("previews edits, saves the draft, and resets the saved theme", async () => {
  const { fetchMock } = await openEditor();
  fetchMock.mockResolvedValueOnce(reply(theme)).mockResolvedValueOnce(reply(null));

  fireEvent.change(screen.getByLabelText("Accent colour"), { target: { value: "#AbC" } });
  fireEvent.change(screen.getByLabelText("Logo URL"), { target: { value: theme.logoUrl } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: theme.message } });

  const preview = within(screen.getByRole("article"));
  expect(preview.getByRole("img")).toHaveAttribute("src", theme.logoUrl);
  expect(preview.getByText(theme.message)).toBeVisible();
  expect(screen.getByRole("article").style.getPropertyValue("--receipt-accent")).toBe("#abc");

  fireEvent.click(screen.getByRole("button", { name: "Save theme" }));
  expect(await screen.findByText("Receipt theme saved.")).toBeVisible();
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/orgs/org-acme/receipt-theme", {
    method: "PUT",
    headers: { "Actor-Wallet-Address": "owner-wallet", "Content-Type": "application/json" },
    body: JSON.stringify({ ...theme, accentColor: "#AbC" }),
  });

  fireEvent.click(screen.getByRole("button", { name: "Reset theme" }));
  expect(await screen.findByText("Receipt theme reset.")).toBeVisible();
  expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/orgs/org-acme/receipt-theme",
    expect.objectContaining({ method: "DELETE" }));
  expect(preview.queryByText(theme.message)).not.toBeInTheDocument();
});

it("shows a read-only preview for members who cannot edit", async () => {
  await openEditor(theme, false);
  expect(screen.getByLabelText("Message")).toBeDisabled();
  expect(screen.getByText(theme.message)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save theme" })).not.toBeInTheDocument();
});

it("has no automated accessibility violations", async () => {
  const { container } = await openEditor(theme);
  expect(await axe(container)).toHaveNoViolations();
});
