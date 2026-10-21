"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  getOnboardingProgress,
  isChecklistHidden,
  setChecklistHidden,
  type OnboardingProgress,
} from "../lib/onboardingProgress";
import { LiveRegion } from "../components/LiveRegion";
import styles from "./OnboardingChecklist.module.css";

export function OnboardingChecklist() {
  const [mounted, setMounted] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [progress, setProgress] = useState<OnboardingProgress>(() =>
    getOnboardingProgress(typeof window !== "undefined" ? window.localStorage : null)
  );
  const [announcement, setAnnouncement] = useState("");
  const isFirstRender = useRef(true);

  const refreshProgress = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      const isHidden = isChecklistHidden(window.localStorage);
      setHidden(isHidden);

      const latest = getOnboardingProgress(window.localStorage);
      setProgress((prev) => {
        // If not initial render and completed count changed, announce
        if (!isFirstRender.current && prev.completed !== latest.completed) {
          setAnnouncement(
            `Checklist updated: ${latest.completed} of ${latest.total} tasks completed.`
          );
        }
        return latest;
      });
    } catch {
      // Safe in private mode
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    refreshProgress();
    isFirstRender.current = false;

    // Cross-tab updates: listen to storage events
    const handleStorage = (e: StorageEvent) => {
      refreshProgress();
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [refreshProgress]);

  const handleHide = () => {
    if (typeof window !== "undefined") {
      setChecklistHidden(window.localStorage, true);
    }
    setHidden(true);
    setAnnouncement("Checklist hidden.");
  };

  // If hidden, do not render checklist UI
  if (hidden) {
    return (
      <LiveRegion
        message={announcement}
        data-testid="onboarding-checklist-live"
      />
    );
  }

  const { items, completed, total } = progress;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  const allDone = completed === total && total > 0;

  return (
    <section
      className={styles["onboarding-checklist"]}
      aria-labelledby="checklist-title"
      data-testid="onboarding-checklist"
    >
      <LiveRegion
        message={announcement}
        data-testid="onboarding-checklist-live"
      />

      <div className={styles["onboarding-checklist__header"]}>
        <div className={styles["onboarding-checklist__title-group"]}>
          <h2 id="checklist-title" className={styles["onboarding-checklist__title"]}>
            Get set up
          </h2>
          <p className={styles["onboarding-checklist__subtitle"]}>
            Complete these recommended steps to start streaming payments seamlessly.
          </p>
        </div>

        <div className={styles["onboarding-checklist__header-actions"]}>
          <button
            type="button"
            className={styles["onboarding-checklist__hide-btn"]}
            onClick={handleHide}
            aria-label="Hide checklist"
          >
            Hide checklist
          </button>
        </div>
      </div>

      <div className={styles["onboarding-checklist__progress"]}>
        <div className={styles["onboarding-checklist__progress-labels"]}>
          <span className={styles["onboarding-checklist__progress-text"]}>
            {completed} of {total} done
          </span>
          <span className={styles["onboarding-checklist__progress-percent"]}>
            {pct}%
          </span>
        </div>
        <div
          className={styles["onboarding-checklist__progress-track"]}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Onboarding progress"
          aria-valuetext={`${completed} of ${total} done`}
        >
          <div
            className={styles["onboarding-checklist__progress-fill"]}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {allDone && (
        <div
          className={styles["onboarding-checklist__completion"]}
          role="status"
          data-testid="onboarding-completion"
        >
          <div
            className={styles["onboarding-checklist__completion-icon"]}
            aria-hidden="true"
          >
            ✓
          </div>
          <div>
            <h3 className={styles["onboarding-checklist__completion-title"]}>
              You're all set!
            </h3>
            <p className={styles["onboarding-checklist__completion-message"]}>
              All onboarding steps are complete. You are ready to create and manage streams with full confidence.
            </p>
          </div>
        </div>
      )}

      <ol className={styles["onboarding-checklist__list"]}>
        {items.map((item) => {
          const isDone = item.status === "completed";
          const isInProgress = item.status === "in_progress";

          return (
            <li
              key={item.id}
              className={`${styles["onboarding-checklist__item"]} ${
                isDone ? styles["onboarding-checklist__item--completed"] : ""
              }`}
              data-testid={`checklist-item-${item.id}`}
            >
              <div className={styles["onboarding-checklist__item-content"]}>
                <div className={styles["onboarding-checklist__item-icon-wrapper"]}>
                  <div
                    className={`${styles["onboarding-checklist__status-icon"]} ${
                      styles[`onboarding-checklist__status-icon--${item.status}`]
                    }`}
                    aria-hidden="true"
                  >
                    {isDone ? "✓" : isInProgress ? "…" : "○"}
                  </div>
                </div>

                <div className={styles["onboarding-checklist__item-details"]}>
                  <div className={styles["onboarding-checklist__item-title-row"]}>
                    <h3 className={styles["onboarding-checklist__item-title"]}>
                      {item.title}
                    </h3>
                    <span
                      className={`${styles["onboarding-checklist__item-status-badge"]} ${
                        styles[`onboarding-checklist__item-status-badge--${item.status}`]
                      }`}
                    >
                      {item.statusText}
                    </span>
                  </div>
                  <p className={styles["onboarding-checklist__item-explanation"]}>
                    {item.explanation}
                  </p>
                </div>
              </div>

              <div className={styles["onboarding-checklist__item-action"]}>
                <Link
                  href={item.href}
                  className={`${styles["onboarding-checklist__item-link"]} ${
                    !isDone ? styles["onboarding-checklist__item-link--primary"] : ""
                  }`}
                  aria-label={`${item.linkText} for ${item.title}`}
                >
                  {item.linkText}
                </Link>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
