/** @jest-environment node */
jest.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
import TemplatesPage from "./page";
import { listTemplates } from "@/app/lib/repositories/templates";
it("passes repository data directly to the client island without fetching its own API", async () => {
  const element = await TemplatesPage({ searchParams: Promise.resolve({}) });
  expect(element.props.initialTemplates).toEqual(listTemplates());
  expect(element.props.initialTemplates).toHaveLength(6);
});
