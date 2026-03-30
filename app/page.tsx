type Stream = {
  id: string;
  recipient: string;
  amount: string;
  cadence: string;
  status: string;
  note: string;
};

const streams: Stream[] = [
  {
    id: "alma-k",
    recipient: "Alma K.",
    amount: "120 XLM / week",
    cadence: "Fridays at 09:00 UTC",
    status: "On track",
    note: "Product design retainer",
  },
  {
    id: "nova-labs",
    recipient: "Nova Labs",
    amount: "480 XLM / month",
    cadence: "1st of each month",
    status: "Needs review",
    note: "Infrastructure contract",
  },
  {
    id: "sani-o",
    recipient: "Sani O.",
    amount: "35 XLM / day",
    cadence: "Daily at 18:00 UTC",
    status: "On track",
    note: "Community moderation",
  },
];

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <div className="app-shell">
        <header className="topbar" aria-label="Workspace header">
          <div className="brand-lockup">
            <a className="brand-link" href="#overview">
              StreamPay
            </a>
            <p className="eyebrow">Stellar streaming workspace</p>
          </div>

          <nav aria-label="Primary">
            <ul className="nav-list">
              <li>
                <a href="#overview">Overview</a>
              </li>
              <li>
                <a href="#streams">Streams</a>
              </li>
              <li>
                <a href="#create-stream">Create stream</a>
              </li>
            </ul>
          </nav>

          <div className="header-actions">
            <a className="button-like secondary-action" href="#create-stream">
              New stream
            </a>
            <button className="button-like primary-action" type="button">
              Connect wallet
            </button>
          </div>
        </header>

        <main className="dashboard" id="main-content">
          <section className="hero panel" id="overview">
            <div>
              <p className="eyebrow">Payment streaming on Stellar</p>
              <h1>Move money with the same confidence as the rest of your app.</h1>
              <p className="hero-copy">
                Review active payouts, jump between sections with the keyboard,
                and create a new stream without leaving the page.
              </p>
            </div>

            <dl className="hero-stats" aria-label="Workspace summary">
              <div>
                <dt>Active streams</dt>
                <dd>12</dd>
              </div>
              <div>
                <dt>Next payout</dt>
                <dd>Today, 18:00 UTC</dd>
              </div>
              <div>
                <dt>Wallet status</dt>
                <dd>Ready to sign</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="streams-heading" className="panel" id="streams">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Streams</p>
                <h2 id="streams-heading">Active streams</h2>
              </div>
              <a className="button-like tertiary-action" href="#create-stream">
                Create from this view
              </a>
            </div>

            <ul className="streams-grid">
              {streams.map((stream) => (
                <li className="stream-card" id={`stream-${stream.id}`} key={stream.id}>
                  <div className="stream-card__header">
                    <div>
                      <h3>
                        <a href={`#stream-${stream.id}`}>
                          Open details for {stream.recipient}
                        </a>
                      </h3>
                      <p>{stream.note}</p>
                    </div>
                    <span className="status-pill">{stream.status}</span>
                  </div>

                  <dl className="stream-metadata">
                    <div>
                      <dt>Rate</dt>
                      <dd>{stream.amount}</dd>
                    </div>
                    <div>
                      <dt>Schedule</dt>
                      <dd>{stream.cadence}</dd>
                    </div>
                  </dl>

                  <div className="stream-actions">
                    <button className="button-like secondary-action" type="button">
                      Pause {stream.recipient}
                    </button>
                    <button className="button-like tertiary-action" type="button">
                      Copy wallet address for {stream.recipient}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="create-stream-heading" className="panel" id="create-stream">
            <div className="section-heading section-heading--stacked">
              <div>
                <p className="eyebrow">Create flow</p>
                <h2 id="create-stream-heading">Create a stream</h2>
              </div>
              <p className="section-copy" id="create-stream-help">
                The fields follow the same order as the final review so the tab
                sequence stays predictable from start to submit.
              </p>
            </div>

            <form
              aria-describedby="create-stream-help"
              aria-labelledby="create-stream-heading"
              className="form-grid"
            >
              <div className="field">
                <label htmlFor="recipient-address">Recipient address</label>
                <input
                  id="recipient-address"
                  name="recipientAddress"
                  placeholder="G..."
                  type="text"
                />
              </div>

              <div className="field">
                <label htmlFor="stream-amount">Amount</label>
                <input
                  id="stream-amount"
                  name="streamAmount"
                  placeholder="120 XLM"
                  type="text"
                />
              </div>

              <div className="field">
                <label htmlFor="distribution-interval">Distribution interval</label>
                <select id="distribution-interval" name="distributionInterval">
                  <option>Daily</option>
                  <option>Weekly</option>
                  <option>Monthly</option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="start-date">Start date</label>
                <input id="start-date" name="startDate" type="date" />
              </div>

              <div className="field field--full">
                <label htmlFor="stream-notes">Notes</label>
                <textarea
                  id="stream-notes"
                  name="streamNotes"
                  placeholder="Add context for reviewers or recipients."
                  rows={4}
                />
              </div>

              <div className="form-actions">
                <button className="button-like primary-action" type="submit">
                  Create stream
                </button>
                <button className="button-like tertiary-action" type="reset">
                  Clear form
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </>
  );
}
