/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthSessionProvider, useAuthSession, useAuthFetch } from "./auth-session";
const TOKEN = "unit-test-token";
function Probe() {
  const session = useAuthSession();
  const authFetch = useAuthFetch();
  return <>
    <button onClick={() => session.setToken(TOKEN)}>Set session</button>
    <button onClick={() => { void authFetch("/api/check"); }}>Call API</button>
    <button onClick={() => { void authFetch("https://untrusted.example/check"); }}>Call external</button>
    <output>{session.token ?? "anonymous"}</output>
  </>;
}
beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ status: 200 });
});
it("keeps JWTs out of browser persistence", async () => {
  const spy = jest.spyOn(Storage.prototype, "setItem");
  render(<AuthSessionProvider><Probe /></AuthSessionProvider>);
  await userEvent.click(screen.getByText("Set session"));
  expect(screen.getByText(TOKEN)).toBeInTheDocument();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
it("attaches a token only to same-origin API requests", async () => {
  render(<AuthSessionProvider><Probe /></AuthSessionProvider>);
  await userEvent.click(screen.getByText("Set session"));
  await userEvent.click(screen.getByText("Call API"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(new Headers(jest.mocked(fetch).mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer " + TOKEN);
  await userEvent.click(screen.getByText("Call external"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(new Headers(jest.mocked(fetch).mock.calls[1][1]?.headers).has("Authorization")).toBe(false);
});
