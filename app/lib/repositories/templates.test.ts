/** @jest-environment node */
import { listTemplates, createTemplate, SEED_TEMPLATES } from "./templates";
describe("shared template repository", () => {
  it("returns the six default presets", () => {
    expect(listTemplates()).toEqual(expect.arrayContaining(SEED_TEMPLATES));
  });
  it("shares newly created templates with subsequent reads without exposing mutable records", () => {
    const input = { ...SEED_TEMPLATES[0], id: "repository-test", name: "Created template" };
    createTemplate(input);
    input.name = "mutated";
    const result = listTemplates().find(template => template.id === input.id)!;
    expect(result.name).toBe("Created template");
    result.name = "also mutated";
    expect(listTemplates().find(template => template.id === input.id)?.name).toBe("Created template");
  });
});
