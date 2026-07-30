"use client";

import React, { useState, useMemo } from "react";

// Helper to calculate next payment dates for the preview
const calculateNextPayments = (startDate: string, frequency: string, count: number) => {
  if (!startDate) return [];
  const dates = [];
  const parts = startDate.split("-").map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return [];
  const current = new Date(parts[0], parts[1] - 1, parts[2]);
  
  for (let i = 0; i < count; i++) {
    dates.push(new Date(current));
    if (frequency === "daily") {
      current.setDate(current.getDate() + 1);
    } else if (frequency === "weekly") {
      current.setDate(current.getDate() + 7);
    } else if (frequency === "monthly") {
      current.setMonth(current.getMonth() + 1);
    }
  }
  return dates;
};

export default function RecurringStreamPage() {
  const [streamName, setStreamName] = useState("");
  const [amount, setAmount] = useState<number>(100);
  const [token, setToken] = useState("USDC");
  const [recipient, setRecipient] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [startDate, setStartDate] = useState(() => {
    const today = new Date();
    return today.toISOString().split("T")[0];
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    
    // Simulate API call for creation
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    setIsSubmitting(false);
    setSuccess(true);
  };

  const previewDates = useMemo(() => {
    return calculateNextPayments(startDate, frequency, 4);
  }, [startDate, frequency]);

  const isValid = streamName.trim().length > 0 && recipient.trim().length > 0 && amount > 0;

  if (success) {
    return (
      <main className="page-shell">
        <section className="page-hero">
          <div>
            <p className="page-hero__eyebrow">Success</p>
            <h1 className="page-hero__title">Stream Created Successfully</h1>
            <p className="page-hero__description">Your recurring stream has been configured and is active.</p>
          </div>
          <button className="button button--primary" onClick={() => window.location.href = '/streams'}>
            View All Streams
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">New Stream</p>
          <h1 className="page-hero__title">Create Recurring Stream</h1>
          <p className="page-hero__description">
            Set up an automated schedule for periodic payments.
          </p>
        </div>
      </section>

      <section style={{ maxWidth: "800px", margin: "0 auto", padding: "0 1.5rem" }}>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
            <div>
              <label htmlFor="streamName" style={{ display: "block", fontSize: "var(--text-sm)", marginBottom: "0.5rem", color: "var(--muted-light)" }}>
                Stream Name
              </label>
              <input
                id="streamName"
                type="text"
                required
                value={streamName}
                onChange={(e) => setStreamName(e.target.value)}
                placeholder="e.g. Monthly Retainer"
                style={{
                  width: "100%",
                  background: "var(--panel)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                  padding: "0.75rem",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--text-base)"
                }}
              />
            </div>
            
            <div>
              <label htmlFor="recipient" style={{ display: "block", fontSize: "var(--text-sm)", marginBottom: "0.5rem", color: "var(--muted-light)" }}>
                Recipient Address
              </label>
              <input
                id="recipient"
                type="text"
                required
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="GABC... or email@example.com"
                style={{
                  width: "100%",
                  background: "var(--panel)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                  padding: "0.75rem",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--text-base)"
                }}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1rem" }}>
              <div>
                <label htmlFor="amount" style={{ display: "block", fontSize: "var(--text-sm)", marginBottom: "0.5rem", color: "var(--muted-light)" }}>
                  Amount per Payment
                </label>
                <input
                  id="amount"
                  type="number"
                  required
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  style={{
                    width: "100%",
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                    padding: "0.75rem",
                    borderRadius: "var(--radius-md)",
                    fontSize: "var(--text-base)"
                  }}
                />
              </div>
              <div>
                <label htmlFor="token" style={{ display: "block", fontSize: "var(--text-sm)", marginBottom: "0.5rem", color: "var(--muted-light)" }}>
                  Token
                </label>
                <select
                  id="token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  style={{
                    width: "100%",
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                    padding: "0.75rem",
                    borderRadius: "var(--radius-md)",
                    fontSize: "var(--text-base)"
                  }}
                >
                  <option value="XLM">XLM</option>
                  <option value="USDC">USDC</option>
                </select>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label htmlFor="frequency" style={{ display: "block", fontSize: "var(--text-sm)", marginBottom: "0.5rem", color: "var(--muted-light)" }}>
                  Frequency
                </label>
                <select
                  id="frequency"
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value)}
                  style={{
                    width: "100%",
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                    padding: "0.75rem",
                    borderRadius: "var(--radius-md)",
                    fontSize: "var(--text-base)"
                  }}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div>
                <label htmlFor="startDate" style={{ display: "block", fontSize: "var(--text-sm)", marginBottom: "0.5rem", color: "var(--muted-light)" }}>
                  Start Date
                </label>
                <input
                  id="startDate"
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={{
                    width: "100%",
                    background: "var(--panel)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                    padding: "0.75rem",
                    borderRadius: "var(--radius-md)",
                    fontSize: "var(--text-base)"
                  }}
                />
              </div>
            </div>
          </div>

          <div style={{ 
            background: "var(--panel)", 
            border: "1px solid var(--border)", 
            borderRadius: "var(--radius-md)",
            padding: "1.5rem"
          }}>
            <h3 style={{ fontSize: "var(--text-base)", marginBottom: "1rem", color: "var(--foreground)" }}>
              Schedule Preview
            </h3>
            {previewDates.length > 0 ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {previewDates.map((date, index) => (
                  <li key={index} style={{ 
                    display: "flex", 
                    justifyContent: "space-between",
                    padding: "0.75rem",
                    background: "var(--background)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)"
                  }}>
                    <span style={{ color: "var(--muted-light)" }}>Payment {index + 1}</span>
                    <span style={{ color: "var(--foreground)", fontWeight: 500 }}>
                      {date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ color: "var(--muted-light)", fontSize: "var(--text-sm)" }}>Select a start date to preview schedule.</p>
            )}
            <p style={{ marginTop: "1rem", fontSize: "var(--text-sm)", color: "var(--muted-light)" }}>
              *Showing the first 4 scheduled payments for visualization.
            </p>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
            <button 
              type="button" 
              className="button button--secondary"
              onClick={() => window.history.back()}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className={`button button--primary ${isSubmitting ? "button--busy" : ""}`}
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? "Creating..." : "Create Recurring Stream"}
            </button>
          </div>

        </form>
      </section>
    </main>
  );
}
