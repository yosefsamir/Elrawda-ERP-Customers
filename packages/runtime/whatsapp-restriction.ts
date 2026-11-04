export type AccountRestriction = {
  active: boolean | null;
  source: "server" | "cache" | "unavailable" | "response";
  enforcementType: string | null;
  endsAt: string | null;
  checkedAt: string;
};

/** Never treat a failed read, missing module or elapsed clock as proof of a lift. */
export function normalizeRestriction(read: any, now = Date.now()): AccountRestriction {
  const base: AccountRestriction = { active: null, source: "unavailable", enforcementType: null,
    endsAt: null, checkedAt: new Date(now).toISOString() };
  if (!read?.available) return base;
  base.source = read.refreshed ? "server" : "cache";
  const value = read.value;
  if (value == null) return { ...base, active: read.refreshed ? false : null };
  if (typeof value !== "object") return base;
  const active = typeof value.isActive === "boolean" ? value.isActive
    : ["HIDDEN", "VISIBLE"].includes(value.state) ? true : null;
  const rawEnd = value.time_enforcement_ends ?? value.timeEnforcementEnds;
  const numeric = rawEnd == null ? NaN : Number(rawEnd);
  const end = value.time_enforcement_ends != null ? numeric : numeric * 1000;
  const validEnd = Number.isFinite(end) && end > 0 && end < 8640000000000000;
  const type = value.enforcement_type ?? value.enforcementType;
  return { ...base, active, endsAt: validEnd ? new Date(end).toISOString() : null,
    enforcementType: typeof type === "string" ? type.slice(0, 100) : null };
}

// Runs in Chromium. Read only this account-limit key, never the auth store.
export async function readRestrictionInPage(refresh: boolean) {
  const win = globalThis as any;
  let refreshed = false;
  if (refresh) {
    try {
      await win.require("WAWebGetReachoutTimelockJob").fetchReachoutTimelock();
      refreshed = true;
    } catch { /* Unsupported/lazy module or network failure: retain unknown/cache. */ }
  }
  try {
    const raw = win.require("WAWebUserPrefsIndexedDBStorage").userPrefsIdb.get("WAReachoutTimelockState");
    return { available: true, refreshed, value: raw == null ? null : {
      state: raw.state, isActive: raw.isActive,
      time_enforcement_ends: raw.time_enforcement_ends,
      timeEnforcementEnds: raw.timeEnforcementEnds,
      enforcement_type: raw.enforcement_type, enforcementType: raw.enforcementType,
    } };
  } catch { return { available: false, refreshed: false, value: null }; }
}
