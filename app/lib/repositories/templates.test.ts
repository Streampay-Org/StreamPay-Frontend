import {
  listTemplates,
  createTemplate,
  resetTemplates,
  SEED_TEMPLATES,
} from "./templates";

describe("templates repository", () => {
  beforeEach(() => {
    resetTemplates();
  });

  it("lists all seed templates by default", async () => {
    const list = await listTemplates();
    expect(list).toHaveLength(SEED_TEMPLATES.length);
    expect(list.map((t) => t.id)).toEqual(SEED_TEMPLATES.map((t) => t.id));
  });

  it("creates a new template and includes it in list", async () => {
    const created = await createTemplate({
      name: "Custom Test Template",
      asset: "USDC",
      amountPerInterval: 100,
      intervalSeconds: 86400,
      memo: "For testing",
    });

    expect(created.id).toMatch(/^tpl_/);
    expect(created.createdAt).toBeDefined();

    const list = await listTemplates();
    expect(list).toHaveLength(SEED_TEMPLATES.length + 1);
    expect(list.find((t) => t.id === created.id)).toEqual(created);
  });

  it("resets back to seeds", async () => {
    await createTemplate({
      name: "Temporary Template",
      asset: "XLM",
      amountPerInterval: 10,
      intervalSeconds: 60,
    });
    expect(await listTemplates()).toHaveLength(SEED_TEMPLATES.length + 1);

    resetTemplates();
    expect(await listTemplates()).toHaveLength(SEED_TEMPLATES.length);
  });
});
