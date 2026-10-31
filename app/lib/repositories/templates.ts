export interface StreamTemplate {
  id: string;
  name: string;
  asset: string;
  amountPerInterval: string;
  intervalSeconds: number;
  memo?: string;
  createdAt: string;
}

// Seeded demo presets so the templates gallery is populated without a database.
export const SEED_TEMPLATES: StreamTemplate[] = [
  { id: "tpl_design_retainer", name: "Monthly Design Retainer", asset: "XLM", amountPerInterval: "120", intervalSeconds: 2592000, memo: "Recurring freelance payment for an ongoing design engagement", createdAt: "2026-01-15T00:00:00.000Z" },
  { id: "tpl_contractor_income", name: "Weekly Contractor Income", asset: "USDC", amountPerInterval: "800", intervalSeconds: 604800, memo: "Salary-style weekly payout for a contractor", createdAt: "2026-02-10T00:00:00.000Z" },
  { id: "tpl_hosting_bill", name: "Hosting Bill", asset: "USDC", amountPerInterval: "45", intervalSeconds: 2592000, memo: "Monthly infrastructure bill payment to a vendor", createdAt: "2026-03-05T00:00:00.000Z" },
  { id: "tpl_savings_roundup", name: "Daily Savings Roundup", asset: "XLM", amountPerInterval: "5", intervalSeconds: 86400, memo: "Move a little into savings every day", createdAt: "2026-04-20T00:00:00.000Z" },
  { id: "tpl_grant_tranche", name: "Grant Milestone Stream", asset: "XLM", amountPerInterval: "1500", intervalSeconds: 1209600, memo: "Bi-weekly grant tranche for an open-source maintainer", createdAt: "2026-05-02T00:00:00.000Z" },
  { id: "tpl_qa_partnership", name: "QA Partnership", asset: "XLM", amountPerInterval: "64", intervalSeconds: 604800, memo: "Weekly QA support stream", createdAt: "2026-06-11T00:00:00.000Z" },
];

const templates = new Map<string, StreamTemplate>(SEED_TEMPLATES.map((t) => [t.id, { ...t }]));


export function listTemplates(): StreamTemplate[] {
  return Array.from(templates.values(), template => ({ ...template }));
}

export function createTemplate(template: StreamTemplate): StreamTemplate {
  templates.set(template.id, { ...template });
  return { ...template };
}
