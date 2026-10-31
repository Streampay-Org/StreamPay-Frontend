import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import { listTemplates } from "@/app/lib/repositories/templates";
import TemplatesPageClient from "./templates-client";

export const metadata: Metadata = {
  title: "Stream templates | StreamPay",
  description: "Browse reusable payment-stream templates.",
};
export const revalidate = 60;
const cachedTemplates = unstable_cache(async () => listTemplates(), ["stream-templates"], { revalidate: 60 });

export default async function TemplatesPage(
  { searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {},
) {
  // Request-bound query state keeps the filter island server-renderable.
  await searchParams;
  const initialTemplates = await cachedTemplates();
  return <TemplatesPageClient initialTemplates={initialTemplates} />;
}
