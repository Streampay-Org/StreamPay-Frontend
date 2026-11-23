type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getStorage(kind: "session" | "local"): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function safeGet(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Safe storage helpers that never throw.
 *
 * Some privacy modes (and blocked-cookie browser configurations) make
 * accessing `sessionStorage`/`localStorage` throw a `SecurityError` on
 * even reading a key. These helpers swallow that and report failure
 * through their return values so callers can degrade gracefully.
 */
export const safeStorage = {
  isAvailable(kind: "session" | "local" = "local"): boolean {
    const storage = getStorage(kind);
    if (!storage) return false;
    try {
      const probeKey = "__streampay_probe__";
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  },

  getItem(key: string, kind: "session" | "local" = "local"): string | null {
    return safeGet(getStorage(kind), key);
  },

  setItem(key: string, value: string, kind: "session" | "local" = "local"): boolean {
    return safeSet(getStorage(kind), key, value);
  },

  removeItem(key: string, kind: "session" | "local" = "local"): void {
    safeRemove(getStorage(kind), key);
  },
};
