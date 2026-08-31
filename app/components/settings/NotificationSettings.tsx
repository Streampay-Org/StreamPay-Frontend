'use client';

import React, { useState, useEffect } from 'react';
import { PushOptIn } from '../PushOptIn';
import { NotificationGroup } from './NotificationGroup';
import { SettingItem } from './SettingItem';
import { ToggleSwitch } from './ToggleSwitch';
import {
  QuietHoursConfig,
  DEFAULT_QUIET_HOURS,
  isValidIanaTimezone,
  isValidTimeFormat,
} from '@/app/lib/quiet-hours';

export interface NotificationPreferences {
  streamStarted: { inApp: boolean; email: boolean };
  streamPaused: { inApp: boolean; email: boolean };
  fundingLow: { inApp: boolean; email: boolean };
  settlementFailed: { inApp: boolean; email: boolean };
  productUpdates: { inApp: boolean; email: boolean };
  communityNews: { inApp: boolean; email: boolean };
  pushFallback: boolean;
  soundEnabled?: boolean;
}

export interface NotificationSettingsProps {
  initialPrefs?: Partial<NotificationPreferences>;
  initialQuietHours?: Partial<QuietHoursConfig>;
  onSave?: (savedPrefs: { prefs: NotificationPreferences; quietHours: QuietHoursConfig }) => Promise<void> | void;
  showSaveButton?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Dubai',
  'Australia/Sydney',
  'Africa/Lagos',
];

export const NotificationSettings: React.FC<NotificationSettingsProps> = ({
  initialPrefs,
  initialQuietHours,
  onSave,
  showSaveButton = false,
  disabled = false,
  readOnly = false,
}) => {
  const isInteractionDisabled = disabled || readOnly;

  const getSystemTimezone = (): string => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return isValidIanaTimezone(tz) ? tz : 'UTC';
    } catch {
      return 'UTC';
    }
  };

  const [prefs, setPrefs] = useState<NotificationPreferences>({
    streamStarted: { inApp: true, email: true },
    streamPaused: { inApp: true, email: true },
    fundingLow: { inApp: true, email: false },
    settlementFailed: { inApp: true, email: true },
    productUpdates: { inApp: false, email: false },
    communityNews: { inApp: false, email: false },
    pushFallback: true,
    soundEnabled: true,
    ...initialPrefs,
  });

  const [quietHours, setQuietHours] = useState<QuietHoursConfig>({
    enabled: initialQuietHours?.enabled ?? DEFAULT_QUIET_HOURS.enabled,
    startTime: initialQuietHours?.startTime ?? DEFAULT_QUIET_HOURS.startTime,
    endTime: initialQuietHours?.endTime ?? DEFAULT_QUIET_HOURS.endTime,
    timezone: initialQuietHours?.timezone ?? getSystemTimezone(),
    daysOfWeek: initialQuietHours?.daysOfWeek ?? DEFAULT_QUIET_HOURS.daysOfWeek,
    allowCriticalAlerts: initialQuietHours?.allowCriticalAlerts ?? DEFAULT_QUIET_HOURS.allowCriticalAlerts,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<{
    startTime?: string;
    endTime?: string;
    timezone?: string;
  }>({});
  const [isDirty, setIsDirty] = useState(false);

  const handleToggle = (
    key: keyof Omit<typeof prefs, 'pushFallback' | 'soundEnabled'>,
    channel: 'inApp' | 'email',
    value: boolean
  ) => {
    if (isInteractionDisabled) return;
    setPrefs((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        [channel]: value,
      },
    }));
    setIsDirty(true);
    setError(null);
    setSuccessMessage(null);
  };

  const handleQuietHoursChange = <K extends keyof QuietHoursConfig>(
    field: K,
    value: QuietHoursConfig[K]
  ) => {
    if (isInteractionDisabled) return;
    setQuietHours((prev) => ({
      ...prev,
      [field]: value,
    }));
    setIsDirty(true);
    setError(null);
    setSuccessMessage(null);
    setValidationErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validateForm = (): boolean => {
    const errors: { startTime?: string; endTime?: string; timezone?: string } = {};

    if (quietHours.enabled) {
      if (!isValidTimeFormat(quietHours.startTime)) {
        errors.startTime = 'Start time must be in 24-hour HH:mm format (e.g., 22:00).';
      }
      if (!isValidTimeFormat(quietHours.endTime)) {
        errors.endTime = 'End time must be in 24-hour HH:mm format (e.g., 08:00).';
      }
      if (!isValidIanaTimezone(quietHours.timezone)) {
        errors.timezone = 'Must be a valid IANA timezone identifier (e.g., UTC, America/New_York).';
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (isInteractionDisabled || isSaving) return;

    if (!validateForm()) {
      setError('Please resolve all validation errors before saving.');
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      if (onSave) {
        await onSave({ prefs, quietHours });
      } else {
        // Fallback simulation if onSave handler is not provided
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      setIsDirty(false);
      setSuccessMessage('Preferences saved successfully.');
    } catch {
      // Preserve form values in state so user data is never lost
      setError('Failed to save preferences. Please check your connection and try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // Ensure user's current timezone option is present in the list
  const timezoneOptions = Array.from(new Set([...COMMON_TIMEZONES, quietHours.timezone])).filter(isValidIanaTimezone);

  return (
    <div className="notification-settings" aria-busy={isSaving}>
      {disabled && (
        <div className="alert alert--warning" role="status">
          You do not have permission to modify notification preferences. Displaying in read-only mode.
        </div>
      )}

      {error && (
        <div className="alert alert--error" role="alert">
          <div className="alert__content">
            <p>{error}</p>
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={handleSave}
              disabled={isSaving}
              style={{ marginTop: '0.5rem' }}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {successMessage && (
        <div className="alert alert--success" role="status">
          {successMessage}
        </div>
      )}

      {isDirty && !isSaving && !error && (
        <div className="alert alert--info" role="status" style={{ opacity: 0.85 }}>
          You have unsaved changes.
        </div>
      )}

      <PushOptIn
        emailFallbackEnabled={prefs.pushFallback}
        onEmailFallbackChange={(nextValue) => {
          if (isInteractionDisabled) return;
          setPrefs((prev) => ({
            ...prev,
            pushFallback: nextValue,
          }));
          setIsDirty(true);
        }}
      />

      <NotificationGroup
        title="Global Preferences"
        description="General settings that apply across all notification types."
      >
        <div className="setting-item">
          <div className="setting-item__info">
            <h3 className="setting-item__label" id="sound-toggle-label">
              Notification Sounds
            </h3>
            <p className="setting-item__description">
              Play an audible sound when a new notification arrives.
            </p>
          </div>
          <div className="setting-item__actions">
            <ToggleSwitch
              id="sound-enabled-toggle"
              label="Play notification sounds"
              checked={prefs.soundEnabled ?? true}
              disabled={isInteractionDisabled || isSaving}
              onChange={(soundEnabled) => {
                if (isInteractionDisabled) return;
                setPrefs((prev) => ({
                  ...prev,
                  soundEnabled,
                }));
                setIsDirty(true);
              }}
            />
          </div>
        </div>
      </NotificationGroup>

      <NotificationGroup
        title="Quiet Hours"
        description="Pause non-critical notifications during designated time windows in your preferred timezone."
      >
        <div className="setting-item">
          <div className="setting-item__info">
            <h3 className="setting-item__label" id="quiet-hours-toggle-label">
              Enable Quiet Hours
            </h3>
            <p className="setting-item__description">
              Mute non-urgent notifications during your scheduled quiet hours window.
            </p>
          </div>
          <div className="setting-item__actions">
            <ToggleSwitch
              id="quiet-hours-toggle"
              label="Enable Quiet Hours schedule"
              checked={quietHours.enabled}
              disabled={isInteractionDisabled || isSaving}
              onChange={(enabled) => handleQuietHoursChange('enabled', enabled)}
            />
          </div>
        </div>

        {quietHours.enabled && (
          <>
            <div className="setting-item setting-item--stacked">
              <div className="setting-item__info">
                <label htmlFor="quiet-hours-start" className="setting-item__label">
                  Start Time (24h)
                </label>
                <p className="setting-item__description">
                  Time when quiet hours begin (inclusive, HH:mm).
                </p>
                {validationErrors.startTime && (
                  <p className="input-error" role="alert" style={{ color: 'var(--color-error, #e53e3e)', fontSize: '0.8125rem' }}>
                    {validationErrors.startTime}
                  </p>
                )}
              </div>
              <div className="setting-item__actions">
                <input
                  type="time"
                  id="quiet-hours-start"
                  name="quietHoursStart"
                  className="input input--time"
                  value={quietHours.startTime}
                  disabled={isInteractionDisabled || isSaving}
                  aria-invalid={Boolean(validationErrors.startTime)}
                  aria-describedby={validationErrors.startTime ? 'quiet-hours-start-error' : undefined}
                  onChange={(e) => handleQuietHoursChange('startTime', e.target.value)}
                />
              </div>
            </div>

            <div className="setting-item setting-item--stacked">
              <div className="setting-item__info">
                <label htmlFor="quiet-hours-end" className="setting-item__label">
                  End Time (24h)
                </label>
                <p className="setting-item__description">
                  Time when notifications resume (exclusive, HH:mm).
                </p>
                {validationErrors.endTime && (
                  <p className="input-error" role="alert" style={{ color: 'var(--color-error, #e53e3e)', fontSize: '0.8125rem' }}>
                    {validationErrors.endTime}
                  </p>
                )}
              </div>
              <div className="setting-item__actions">
                <input
                  type="time"
                  id="quiet-hours-end"
                  name="quietHoursEnd"
                  className="input input--time"
                  value={quietHours.endTime}
                  disabled={isInteractionDisabled || isSaving}
                  aria-invalid={Boolean(validationErrors.endTime)}
                  aria-describedby={validationErrors.endTime ? 'quiet-hours-end-error' : undefined}
                  onChange={(e) => handleQuietHoursChange('endTime', e.target.value)}
                />
              </div>
            </div>

            <div className="setting-item setting-item--stacked">
              <div className="setting-item__info">
                <label htmlFor="quiet-hours-timezone" className="setting-item__label">
                  Timezone
                </label>
                <p className="setting-item__description">
                  Quiet hours schedule evaluates against wall-clock time in this timezone with Daylight Saving Time (DST) safety.
                </p>
                {validationErrors.timezone && (
                  <p className="input-error" role="alert" style={{ color: 'var(--color-error, #e53e3e)', fontSize: '0.8125rem' }}>
                    {validationErrors.timezone}
                  </p>
                )}
              </div>
              <div className="setting-item__actions">
                <select
                  id="quiet-hours-timezone"
                  name="quietHoursTimezone"
                  className="input input--select"
                  value={quietHours.timezone}
                  disabled={isInteractionDisabled || isSaving}
                  aria-invalid={Boolean(validationErrors.timezone)}
                  onChange={(e) => handleQuietHoursChange('timezone', e.target.value)}
                >
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="setting-item">
              <div className="setting-item__info">
                <h3 className="setting-item__label">Allow Critical Alerts</h3>
                <p className="setting-item__description">
                  Urgent alerts (settlement failure, payment failure, low balance) bypass quiet hours.
                </p>
              </div>
              <div className="setting-item__actions">
                <ToggleSwitch
                  id="quiet-hours-critical-bypass"
                  label="Allow critical alerts during quiet hours"
                  checked={quietHours.allowCriticalAlerts ?? true}
                  disabled={isInteractionDisabled || isSaving}
                  onChange={(allowCriticalAlerts) =>
                    handleQuietHoursChange('allowCriticalAlerts', allowCriticalAlerts)
                  }
                />
              </div>
            </div>
          </>
        )}
      </NotificationGroup>

      <NotificationGroup
        title="Money Movement"
        description="Critical alerts regarding your payment streams and Stellar network status."
      >
        <SettingItem
          id="stream-started"
          label="Stream Started"
          description="When a new payment stream is successfully initiated."
          inApp={prefs.streamStarted.inApp}
          email={prefs.streamStarted.email}
          onInAppChange={(value) => handleToggle('streamStarted', 'inApp', value)}
          onEmailChange={(value) => handleToggle('streamStarted', 'email', value)}
        />
        <SettingItem
          id="stream-paused"
          label="Stream Paused"
          description="When a stream is paused by you or the recipient."
          inApp={prefs.streamPaused.inApp}
          email={prefs.streamPaused.email}
          onInAppChange={(value) => handleToggle('streamPaused', 'inApp', value)}
          onEmailChange={(value) => handleToggle('streamPaused', 'email', value)}
        />
        <SettingItem
          id="funding-low"
          label="Funding Low"
          description="Warning when your source balance is insufficient for future payments."
          inApp={prefs.fundingLow.inApp}
          email={prefs.fundingLow.email}
          onInAppChange={(value) => handleToggle('fundingLow', 'inApp', value)}
          onEmailChange={(value) => handleToggle('fundingLow', 'email', value)}
        />
        <SettingItem
          id="settlement-failed"
          label="Settlement Failed"
          description="Immediate alert if an on-chain transaction fails."
          inApp={prefs.settlementFailed.inApp}
          email={prefs.settlementFailed.email}
          onInAppChange={(value) => handleToggle('settlementFailed', 'inApp', value)}
          onEmailChange={(value) => handleToggle('settlementFailed', 'email', value)}
        />
      </NotificationGroup>

      <NotificationGroup
        title="Product Information"
        description="Stay updated with the latest from StreamPay."
      >
        <SettingItem
          id="product-updates"
          label="Product Updates"
          description="New features, enhancements, and technical updates."
          inApp={prefs.productUpdates.inApp}
          email={prefs.productUpdates.email}
          onInAppChange={(value) => handleToggle('productUpdates', 'inApp', value)}
          onEmailChange={(value) => handleToggle('productUpdates', 'email', value)}
        />
        <SettingItem
          id="community-news"
          label="Community News"
          description="Updates from the StreamPay DAO and ecosystem."
          inApp={prefs.communityNews.inApp}
          email={prefs.communityNews.email}
          onInAppChange={(value) => handleToggle('communityNews', 'inApp', value)}
          onEmailChange={(value) => handleToggle('communityNews', 'email', value)}
        />
      </NotificationGroup>

      {showSaveButton && (
        <div className="settings-actions">
          <button
            className="button button--primary"
            disabled={isInteractionDisabled || isSaving}
            onClick={handleSave}
            type="button"
            aria-busy={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      )}
    </div>
  );
};
