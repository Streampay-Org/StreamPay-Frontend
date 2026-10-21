'use client';

import React, { ReactNode, useCallback, useRef, useState } from 'react';

export interface TabDefinition {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  tabs: TabDefinition[];
  defaultTabId?: string;
  onChange?: (tabId: string) => void;
  /**
   * Optional guard run before a tab becomes active. Return `false` (or a
   * promise that resolves `false`) to keep the current tab selected.
   */
  onBeforeChange?: (
    nextTabId: string,
    origin?: HTMLElement
  ) => boolean | Promise<boolean>;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  defaultTabId,
  onChange,
  onBeforeChange,
}) => {
  const [activeTabId, setActiveTabId] = useState<string>(
    defaultTabId || tabs[0]?.id || ''
  );
  const pendingChangeRef = useRef(false);

  const commitTabChange = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      onChange?.(tabId);
    },
    [onChange]
  );

  const handleTabClick = useCallback(
    (tabId: string, origin?: HTMLElement) => {
      if (tabId === activeTabId || pendingChangeRef.current) return;

      const guardResult = onBeforeChange?.(tabId, origin);
      if (guardResult === undefined || guardResult === true) {
        commitTabChange(tabId);
        return;
      }
      if (guardResult === false) return;

      pendingChangeRef.current = true;
      Promise.resolve(guardResult).then(
        (allowed) => {
          pendingChangeRef.current = false;
          if (allowed) commitTabChange(tabId);
        },
        () => {
          pendingChangeRef.current = false;
        }
      );
    },
    [activeTabId, commitTabChange, onBeforeChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      let nextIndex: number | null = null;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        nextIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
        e.preventDefault();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        nextIndex = currentIndex === tabs.length - 1 ? 0 : currentIndex + 1;
        e.preventDefault();
      } else if (e.key === 'Home') {
        nextIndex = 0;
        e.preventDefault();
      } else if (e.key === 'End') {
        nextIndex = tabs.length - 1;
        e.preventDefault();
      }

      if (nextIndex !== null) {
        handleTabClick(
          tabs[nextIndex].id,
          e.currentTarget as HTMLElement
        );
      }
    },
    [tabs, handleTabClick]
  );

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);

  return (
    <div className="tabs">
      <div className="tabs__header" role="tablist" aria-label="Settings">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTabId === tab.id}
            aria-controls={`${tab.id}-panel`}
            id={`${tab.id}-tab`}
            className={`tabs__button ${
              activeTabId === tab.id ? 'tabs__button--active' : ''
            }`}
            onClick={(event) => handleTabClick(tab.id, event.currentTarget)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${activeTab?.id}-panel`}
        aria-labelledby={`${activeTab?.id}-tab`}
        className="tabs__content"
      >
        {activeTab?.content}
      </div>
    </div>
  );
};
