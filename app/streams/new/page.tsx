import { StreamForm } from "@/app/components/StreamForm";

export const metadata = {
  title: "Create Stream — StreamPay",
  description: "Create a new payment stream to pay collaborators and vendors on a steady schedule.",
};

export default function NewStreamPage() {
  return (
    <main className="page-shell">
      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">Streams</p>
          <h1 className="page-hero__title">Create a new stream</h1>
          <p className="page-hero__description">
            Set up a payment stream to send funds on a recurring schedule.
          </p>
        </div>
      </section>

      <StreamForm />
    </main>
  );
}
