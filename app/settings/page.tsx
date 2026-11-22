'use client';

import React, { useCallback, useRef, useState } from 'react';
import { ThemeToggle } from '../components/ThemeToggle';
import { Tabs, TabDefinition } from '../components/Tabs';
import { Modal } from '../components/Modal';
import {
  NotificationSettings,
  NotificationSettingsHandle,
  NotificationPreferences,
} from '../components/settings/NotificationSettings';
import { QuietHoursConfig } from '../lib/quiet-hours';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';

interface SavedNotificationPreferences {
  prefs: NotificationPreferences;
  quietHours: QuietHoursConfig;
}

export interface SettingsPageContentProps {
  onSaveNotifications?: (
    saved: SavedNotificationPreferences
  ) => Promise<void> | void;
}

const defaultSaveNotifications = async () => {};

export function SettingsPageContent({
  onSaveNotifications = defaultSaveNotifications,
}: SettingsPageContentProps) {
  const [activeTab, setActiveTab] = useState<string>('appearance');
  const [notificationsDirty, setNotificationsDirty] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [isSavingFromDialog, setIsSavingFromDialog] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] =
    useState<HTMLElement | null>(null);

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
    isDirty: notificationsDirty,
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
    setNotificationsDirty(false);
    settleConfirmation(true);
  }, [settleConfirmation]);

  const handleSaveAndLeave = useCallback(async () => {
    setConfirmError(null);
    setIsSavingFromDialog(true);
    const saved = (await notificationSettingsRef.current?.save()) ?? false;
    setIsSavingFromDialog(false);

    if (saved) {
      // The child reports this too, but it may unmount as part of the pending
      // tab change before its effect runs, so clear the guard here as well.
      setNotificationsDirty(false);
      settleConfirmation(true);
    } else {
      setConfirmError(
        'We could not save your notification preferences. Please try again.'
      );
    }
  }, [settleConfirmation]);

  const handleBeforeTabChange = useCallback(
    (nextTabId: string, origin?: HTMLElement) => {
      if (!notificationsDirty || nextTabId === activeTab) return true;
      return confirmNavigation(origin);
    },
    [activeTab, confirmNavigation, notificationsDirty]
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
        title="You have unsaved notification changes"
        restoreFocusTarget={restoreFocusTarget}
      >
        <p>
          Your notification preference changes have not been saved. Save them
          before leaving, discard them, or cancel to keep editing.
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
    </main>
  );
}

export default function SettingsPage() {
  return <SettingsPageContent />;
}
