export interface StreamTemplate {
  id: string;
  name: string;
  asset: string;
  amountPerInterval: number;
  intervalSeconds: number;
  memo?: string;
  createdAt: string;
}

export const SEED_TEMPLATES: StreamTemplate[] = [
  {
    id: "tpl_1",
    name: "Monthly Savings",
    asset: "XLM",
    amountPerInterval: 50,
    intervalSeconds: 2592000,
    memo: "Automated monthly savings",
    createdAt: "2026-01-15T00:00:00.000Z",
  },
  {
    id: "tpl_2",
    name: "Freelancer Income",
    asset: "USDC",
    amountPerInterval: 2000,
    intervalSeconds: 604800,
    memo: "Weekly freelancer payout",
    createdAt: "2026-02-10T00:00:00.000Z",
  },
  {
    id: "tpl_3",
    name: "Utility Bill",
    asset: "XLM",
    amountPerInterval: 120,
    intervalSeconds: 2592000,
    memo: "Monthly utility payment",
    createdAt: "2026-03-05T00:00:00.000Z",
  },
  {
    id: "tpl_4",
    name: "Savings Roundup",
    asset: "XLM",
    amountPerInterval: 10,
    intervalSeconds: 86400,
    createdAt: "2026-04-20T00:00:00.000Z",
  },
  {
    id: "tpl_5",
    name: "Rent Split",
    asset: "USDC",
    amountPerInterval: 750,
    intervalSeconds: 2592000,
    memo: "Monthly rent contribution",
    createdAt: "2026-05-01T00:00:00.000Z",
  },
  {
    id: "tpl_6",
    name: "Micro Investment",
    asset: "XLM",
    amountPerInterval: 5,
    intervalSeconds: 3600,
    memo: "Hourly micro-investing",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
];

const templates = new Map<string, StreamTemplate>(
  SEED_TEMPLATES.map((t) => [t.id, t])
);

export async function listTemplates(): Promise<StreamTemplate[]> {
  return Array.from(templates.values());
}

export async function createTemplate(
  data: Omit<StreamTemplate, "id" | "createdAt">
): Promise<StreamTemplate> {
  const template: StreamTemplate = {
    ...data,
    id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };
  templates.set(template.id, template);
  return template;
}

export function resetTemplates(): void {
  templates.clear();
  for (const t of SEED_TEMPLATES) {
    templates.set(t.id, t);
  }
}
