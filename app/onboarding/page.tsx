import { Explainer } from "../components/Explainer";
import { OnboardingChecklist } from "./OnboardingChecklist";

export default function OnboardingPage() {
  return (
    <main className="page-shell">
      <header className="page-hero">
        <div>
          <p className="page-hero__eyebrow">New to StreamPay</p>
          <h1 className="page-hero__title">How streaming works</h1>
          <p className="page-hero__description">
            Learn the setup, flow, and payout checkpoints before you launch your first StreamPay stream.
          </p>
        </div>
      </header>

      <OnboardingChecklist />

      <Explainer />
    </main>
  );
}
