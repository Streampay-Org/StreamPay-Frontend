'use client';

import React, { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { ThemeToggle } from '../components/ThemeToggle';
import { Tabs, TabDefinition } from '../components/Tabs';
import { Modal } from '../components/Modal';
import { ReceiptThemeEditor, type ReceiptThemeEditorHandle } from '../components/settings/ReceiptThemeEditor';
import {
  NotificationSettings,
  NotificationSettingsHandle,
  NotificationPreferences,
} from '../components/settings/NotificationSettings';
import { QuietHoursConfig } from '../lib/quiet-hours';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import type { AuditActorRole } from '../types/audit';

const PRIVILEGED_AUDIT_ROLES = new Set<AuditActorRole>([
  'support',
  'admin',
  'finance',
  'security',
  'compliance',
]);
import { TimeZoneSettings } from '../components/settings/TimeZoneSettings';

interface SavedNotificationPreferences {
  prefs: NotificationPreferences;
  quietHours: QuietHoursConfig;
}

export interface SettingsPageContentProps {
  onSaveNotifications?: (
    saved: SavedNotificationPreferences
  ) => Promise<void> | void;
  userRole?: AuditActorRole;
}

const defaultSaveNotifications = async () => {};

export function SettingsPageContent({
  onSaveNotifications = defaultSaveNotifications,
  userRole,
}: SettingsPageContentProps) {
  const [activeTab, setActiveTab] = useState<string>('appearance');
  const [notificationsDirty, setNotificationsDirty] = useState(false);
  const [receiptsDirty, setReceiptsDirty] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [isSavingFromDialog, setIsSavingFromDialog] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] =
    useState<HTMLElement | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const receiptsActive = activeTab === 'receipts';
  const isDirty = receiptsActive ? receiptsDirty : notificationsDirty;
  const receiptThemeRef = useRef<ReceiptThemeEditorHandle>(null);
  const notificationSettingsRef = useRef<NotificationSettingsHandle>(null);
  const pendingConfirmationRef = useRef<
    ((allowed: boolean) => void) | null
  >(null);

  const requestConfirmation = useCallback((origin?: HTMLElement | null) => {
    // If a confirmation is already open, treat it as cancelled before the new
    // request replaces it so no waiter is left hanging.
    pendingConfirmationRef.current?.(false);
    pendingConfirmationRef.current = null;

    setRestoreFocusTarget(
      origin ??
        (typeof document !== 'undefined'
          ? (document.activeElement as HTMLElement | null)
          : null)
    );
    setConfirmError(null);
    setIsConfirmOpen(true);

    return new Promise<boolean>((resolve) => {
      pendingConfirmationRef.current = resolve;
    });
  }, []);

  const { confirmNavigation } = useUnsavedChangesGuard({
    isDirty,
    onConfirm: requestConfirmation,
  });

  const settleConfirmation = useCallback((allowed: boolean) => {
    const resolve = pendingConfirmationRef.current;
    pendingConfirmationRef.current = null;
    setIsConfirmOpen(false);
    setConfirmError(null);
    resolve?.(allowed);
  }, []);

  const handleCancel = useCallback(() => {
    settleConfirmation(false);
  }, [settleConfirmation]);

  const handleDiscard = useCallback(() => {
    // The user explicitly chose to leave; clear the guard so the incoming tab
    // change is not blocked and a later visit starts from a clean form.
    if (receiptsActive) setReceiptsDirty(false);
    else setNotificationsDirty(false);
    settleConfirmation(true);
  }, [receiptsActive, settleConfirmation]);

  const handleSaveAndLeave = useCallback(async () => {
    setConfirmError(null);
    setIsSavingFromDialog(true);
    const form = receiptsActive ? receiptThemeRef.current : notificationSettingsRef.current;
    const saved = await form?.save();
    setIsSavingFromDialog(false);

    if (saved) {
      // The child reports this too, but it may unmount as part of the pending
      // tab change before its effect runs, so clear the guard here as well.
      if (receiptsActive) setReceiptsDirty(false);
      else setNotificationsDirty(false);
      settleConfirmation(true);
    } else {
      setConfirmError(
        receiptsActive
          ? 'We could not save your receipt theme. Check the theme fields and try again.'
          : 'We could not save your notification preferences. Please try again.'
      );
    }
  }, [receiptsActive, settleConfirmation]);

  const handleBeforeTabChange = useCallback(
    (nextTabId: string, origin?: HTMLElement) => {
      if (!isDirty || nextTabId === activeTab) return true;
      return confirmNavigation(origin);
    },
    [activeTab, confirmNavigation, isDirty]
  );

  const settingsTabs: TabDefinition[] = [
    {
      id: 'appearance',
      label: 'Appearance',
      content: (
        <section className="settings-group">
          <div className="settings-group__header">
            <h2 className="settings-group__title">Appearance</h2>
            <p className="settings-group__description">Customize how StreamPay looks on your device.</p>
          </div>
          <div className="settings-group__content">
            <ThemeToggle />
            <TimeZoneSettings />
          </div>
        </section>
      ),
    },
    {
      id: 'notifications',
      label: 'Notifications',
      content: (
        <section className="settings-group">
          <div className="settings-group__header">
            <h2 className="settings-group__title">Notifications</h2>
            <p className="settings-group__description">
              Manage instant push prompts and keep email fallback ready for critical stream alerts.
            </p>
          </div>
          <div className="settings-group__content" style={{ marginTop: '1rem' }}>
            <NotificationSettings
              ref={notificationSettingsRef}
              onDirtyChange={setNotificationsDirty}
              onSave={onSaveNotifications}
            />
          </div>
        </section>
      ),
    },
    {
      id: 'privacy',
      label: 'Privacy',
      content: (
        <section className="settings-group">
          <div className="settings-group__header">
            <h2 className="settings-group__title">Privacy</h2>
            <p className="settings-group__description">
              Manage your personal data and submit a Data Subject Request (DSR)
              for account deletion.
            </p>
          </div>
          <div className="settings-group__content" style={{ marginTop: '1rem' }}>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div>
                <h3>What is deleted</h3>
                <p>
                  All personally identifiable information (PII) — including your
                  user record (wallet address, email, display name) and stream
                  PII (email, label, memo, partner ID) — is permanently scrubbed
                  within 30 days.
                </p>
              </div>
              <div>
                <h3>What is retained</h3>
                <p>
                  De-identified aggregate stream records (Stream IDs, amounts,
                  status, timestamps) are retained for 7 years to satisfy legal
                  and audit requirements. On-chain transaction data is immutable
                  and cannot be removed.
                </p>
              </div>
              <div style={{ marginTop: '0.5rem' }}>
                <button
                  ref={deleteTriggerRef}
                  type="button"
                  className="button button--danger"
                  onClick={() => setIsDeleteDialogOpen(true)}
                >
                  Request account deletion
                </button>
              </div>
            </div>
          </div>
        </section>
      ),
    },
    {
      id: 'receipts',
      label: 'Receipts',
            <h2 className="settings-group__title">Organization receipt themes</h2>
          <div className="settings-group__content">
            <ReceiptThemeEditor ref={receiptThemeRef} onDirtyChange={setReceiptsDirty}
              confirmNavigation={confirmNavigation} />
      ),
    },
  ];

  return (
    <main className="page-shell">
      <header className="page-hero">
        <div className="page-hero__content">
          <p className="page-hero__eyebrow">User Settings</p>
          <h1 className="page-hero__title">Preferences</h1>
          <p className="page-hero__description">
            Manage your account preferences and appearance settings.
          </p>
          <nav aria-label="More settings" style={{ display: 'flex', gap: '1rem' }}>
            <Link href="/settings/webhooks">Webhook console</Link>
            <Link href="/exports">Data exports</Link>
            {userRole && PRIVILEGED_AUDIT_ROLES.has(userRole) && (
              <Link href="/audit">Audit log</Link>
            )}
          </nav>
        </div>
      </header>

      <div className="settings-layout">
        <Tabs
          tabs={settingsTabs}
          defaultTabId={activeTab}
          onChange={setActiveTab}
          onBeforeChange={handleBeforeTabChange}
        />
      </div>

      <Modal
        isOpen={isConfirmOpen}
        onClose={handleCancel}
        title={receiptsActive ? "You have unsaved receipt changes" : "You have unsaved notification changes"}
        restoreFocusTarget={restoreFocusTarget}
      >
        <p>
          {receiptsActive
            ? 'Save your receipt theme before leaving, discard your edits, or cancel to keep editing.'
            : 'Your notification preference changes have not been saved. Save them before leaving, discard them, or cancel to keep editing.'}
        </p>

        {confirmError && (
          <p role="alert" style={{ color: 'var(--system-error-text)', marginTop: '1rem' }}>
            {confirmError}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            justifyContent: 'flex-end',
            marginTop: '1.5rem',
          }}
        >
          <button
            type="button"
            className="button button--secondary"
            onClick={handleCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={handleDiscard}
            disabled={isSavingFromDialog}
          >
            Discard
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={handleSaveAndLeave}
            disabled={isSavingFromDialog}
          >
            {isSavingFromDialog ? 'Saving...' : 'Save'}
          </button>
        </div>
      </Modal>

      <DeleteAccountDialog
        isOpen={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        restoreFocusTarget={deleteTriggerRef}
        getAuthToken={getAuthToken}
      />
    </main>
  );
}

export default function SettingsPage() {
  return <SettingsPageContent />;
}
