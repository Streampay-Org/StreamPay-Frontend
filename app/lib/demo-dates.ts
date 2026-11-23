/**
 * Demo fixtures are written with fixed timestamps. Shown as-is they quickly age
 * ("2 years ago", a stream that "ended yesterday" two years back), so outside of
 * tests we slide them forward so the newest fixture lands just before "now",
 * preserving the spacing between events. Under Jest the original values are
 * returned unchanged so assertions stay deterministic.
 */
export function makeDemoDateShifter(anchorIso: string, now: number = Date.now()) {
  const anchor = Date.parse(anchorIso);
  const enabled = process.env.NODE_ENV !== "test" && Number.isFinite(anchor);
  const delta = enabled ? now - anchor : 0;
  return function shift(iso: string): string {
    if (!delta) return iso;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t + delta).toISOString() : iso;
  };
}
