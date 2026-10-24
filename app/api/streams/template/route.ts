import { NextRequest, NextResponse } from "next/server";
import {
  listTemplates,
  createTemplate,
  type StreamTemplate,
} from "@/app/lib/repositories/templates";

export { type StreamTemplate };

export async function GET() {
  const allTemplates = await listTemplates();
  return NextResponse.json({ templates: allTemplates });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, asset, amountPerInterval, intervalSeconds, memo } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!asset || typeof asset !== "string") {
      return NextResponse.json({ error: "asset is required" }, { status: 400 });
    }
    if (typeof amountPerInterval !== "number" || amountPerInterval <= 0) {
      return NextResponse.json(
        { error: "amountPerInterval must be positive" },
        { status: 400 }
      );
    }
    if (typeof intervalSeconds !== "number" || intervalSeconds <= 0) {
      return NextResponse.json(
        { error: "intervalSeconds must be positive" },
        { status: 400 }
      );
    }

    const template = await createTemplate({
      name,
      asset,
      amountPerInterval,
      intervalSeconds,
      memo: memo ? String(memo) : undefined,
    });

    return NextResponse.json({ template }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}
