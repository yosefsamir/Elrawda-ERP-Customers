import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { normalizeRestriction, readRestrictionInPage } from "../packages/runtime/whatsapp-restriction.js";

test("restriction timestamps preserve both cached milliseconds and response seconds without assuming expiry", () => {
  const milliseconds = 1793800800000;
  const cached = normalizeRestriction({ available: true, refreshed: false,
    value: { state: "HIDDEN", time_enforcement_ends: milliseconds, enforcement_type: "DEFAULT" } });
  assert.equal(cached.active, true);
  assert.equal(cached.source, "cache");
  assert.equal(cached.endsAt, new Date(milliseconds).toISOString());
  const server = normalizeRestriction({ available: true, refreshed: true,
    value: { isActive: true, timeEnforcementEnds: milliseconds / 1000 } }, milliseconds + 86400000);
  assert.equal(server.active, true, "a past deadline is not proof that WhatsApp lifted a restriction");
  assert.equal(server.endsAt, cached.endsAt);
  assert.equal(normalizeRestriction({ available: true, value: { state: "VISIBLE", time_enforcement_ends: "bad" } }).endsAt, null);
});

test("only a successful server refresh with an empty state proves no restriction; missing modules stay unknown", async () => {
  assert.equal(normalizeRestriction({ available: true, refreshed: false, value: null }).active, null);
  assert.equal(normalizeRestriction({ available: true, refreshed: true, value: null }).active, false);
  assert.equal(normalizeRestriction({ available: false, refreshed: true, value: null }).active, null);
  const read = await runInNewContext(`(${readRestrictionInPage.toString()})(true)`, {
    require: () => { throw new Error("module unavailable"); },
  });
  assert.equal(normalizeRestriction(read).source, "unavailable");
});

test("the page reader whitelists account-limit fields and does not return other stored data", async () => {
  let refreshed = 0;
  const read = await runInNewContext(`(${readRestrictionInPage.toString()})(true)`, {
    require: (name: string) => {
      if (name === "WAWebGetReachoutTimelockJob") return { fetchReachoutTimelock: async () => { refreshed++; } };
      if (name === "WAWebUserPrefsIndexedDBStorage") return { userPrefsIdb: { get: (key: string) => {
        assert.equal(key, "WAReachoutTimelockState");
        return { state: "VISIBLE", time_enforcement_ends: 1793800800000, secret: "must-stay-in-page" };
      } } };
      throw new Error("unexpected store access");
    },
  });
  assert.equal(refreshed, 1);
  assert.equal(normalizeRestriction(read).active, true);
  assert.ok(!JSON.stringify(read).includes("must-stay-in-page"));
});
