import { notFound } from "next/navigation";
import { getStore } from "@/app/lib/db";
import { toAnonymousReceipt } from "@/app/lib/anon-receipt";
import { verifyEmbedToken } from "@/lib/embed-token";
import EmbedResize from "./EmbedResize";

type EmbedStreamPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
};

function getProgress(status: string): number {
  switch (status.toLowerCase()) {
    case "completed":
    case "settled":
      return 100;
    case "active":
      return 50;
    case "cancelled":
    case "failed":
      return 0;
    default:
      return 10;
  }
}

export default async function EmbedStreamPage({
  params,
  searchParams,
}: EmbedStreamPageProps) {
  const [{ id }, { t }] = await Promise.all([params, searchParams]);

  if (!id || id.length > 256 || !t || t.length > 2048) {
    notFound();
  }

  const stream = await getStore().streamRepository.streams.get(id);

  if (!stream || !verifyEmbedToken(t, id)) {
    notFound();
  }

  const receipt = toAnonymousReceipt(stream);
  const progress = getProgress(receipt.status);

  return (
    <main className="min-h-screen bg-transparent p-4 text-slate-900">
         <EmbedResize />
      <section
        className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="Stream payment status"
      >
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">StreamPay</h1>

          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium capitalize">
            {receipt.status.replace(/_/g, " ").toLowerCase()}
          </span>
        </div>

        <div className="mt-6">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Payment progress</span>
            <span className="font-medium">{progress}%</span>
          </div>

          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="mt-6 space-y-4 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Recipient</span>
            <span className="font-medium">{receipt.recipientMasked}</span>
          </div>

          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Rate</span>
            <span className="font-medium">{receipt.rate}</span>
          </div>

          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Schedule</span>
            <span className="font-medium">{receipt.schedule}</span>
          </div>
        </div>

        <p className="mt-6 border-t border-slate-100 pt-4 text-center text-xs text-slate-400">
          Read-only payment information provided by StreamPay.
        </p>
      </section>
    </main>
  );
}