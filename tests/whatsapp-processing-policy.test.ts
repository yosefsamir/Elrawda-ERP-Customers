import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../packages/storage/database.js";
import { CompanyRepository, calculateAdditionInterval } from "../packages/storage/company-repository.js";
import { ExecutionEngine } from "../apps/server/execution-engine.js";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "wa-processing-policy-"));
  const db = openDatabase(join(dir, "app.sqlite"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO operators VALUES('op','op','hash')").run();
  const repo = new CompanyRepository(db), id = repo.create("op", "Trial");
  let now = Date.now();
  const branches = [{ idprogramitems: 9, idbranch: 39, fbranch: "A", fvis: true }];
  const row = (person: number) => ({ idprogramitems: 9, idbranch: 39, idperson: person,
    fperson: "Customer", ftel1: `0101234567${person}` });
  repo.ingest(id, { identity: "trial", label: "trial", branches, customers: [row(1)] }, "snapshot");
  repo.ingest(id, { identity: "trial", label: "trial", branches, customers: [row(1), row(2), row(3)] }, "snapshot");
  db.prepare("UPDATE companies SET paused=0,run_mode='live' WHERE id=?").run(id);
  db.prepare("UPDATE branches SET group_id='120363000000000001@g.us'").run();
  const settings = (extra: object) => db.prepare("UPDATE companies SET settings=? WHERE id=?")
    .run(JSON.stringify({ ...repo.settings(id), ...extra }), id);
  settings({ workStart: "00:00", workEnd: "23:59", historicalDailyLimit: 10 });
  const calls: string[] = [];
  const wa: any = { state: { companyId: id, status: "ready" }, call: async (_id: string, action: string) => {
    calls.push(action);
    return action === "get_group_info" ? { participantCount: 3 } : { status: "joined", code: 200 };
  } };
  return { db, repo, id, wa, calls, settings, now: () => now, advance: (ms: number) => { now += ms; },
    engine: () => new ExecutionEngine(db, repo, wa, () => now) };
}

test("new and historical additions share a durable rolling budget and minimum interval", async t => {
  const f = fixture(t);
  f.settings({ additionDailyLimit: 2 });
  // Leave one new and one historical candidate, to exercise both queues.
  f.db.prepare("UPDATE customers SET membership_state='review' WHERE person_id=3").run();
  await f.engine().tick();
  assert.equal((f.db.prepare("SELECT membership_state FROM customers WHERE person_id=2").get() as any).membership_state, "joined");
  await f.engine().tick(); // Simulates a restarted engine, not an in-memory limiter.
  assert.deepEqual(f.calls, ["get_group_info", "add_participant"]);
  f.advance(100000);
  await f.engine().tick();
  assert.equal((f.db.prepare("SELECT membership_state FROM customers WHERE person_id=1").get() as any).membership_state, "joined");
  f.db.prepare("UPDATE customers SET membership_state='not_attempted' WHERE person_id=3").run();
  f.advance(100000);
  await f.engine().tick();
  assert.equal(f.calls.length, 4);
  assert.equal(f.repo.additionBudget(f.id, f.now()).used, 2);
  f.advance(86400000);
  await f.engine().tick();
  assert.equal(f.calls.length, 6);
});

test("an uncertain addition consumes the budget across restart and is not retried", async t => {
  const f = fixture(t);
  f.settings({ additionDailyLimit: 1 });
  f.wa.call = async (_id: string, action: string) => {
    f.calls.push(action);
    if (action === "get_group_info") return { participantCount: 3 };
    throw new Error("reply lost after write");
  };
  await f.engine().tick();
  f.advance(120000);
  await f.engine().tick();
  assert.deepEqual(f.calls, ["get_group_info", "add_participant"]);
  assert.equal((f.db.prepare("SELECT status FROM operations WHERE kind='add'").get() as any).status, "unknown");
});

test("privacy refusal sends no message and sets customer to review", async t => {
  const f = fixture(t);
  const saved: any = f.repo.settings(f.id);
  delete saved.additionMinIntervalSeconds; delete saved.additionDailyLimit;
  f.db.prepare("UPDATE companies SET settings=? WHERE id=?").run(JSON.stringify(saved), f.id);
  f.wa.call = async (_id: string, action: string) => {
    f.calls.push(action);
    return action === "get_group_info" ? { participantCount: 3 } : { status: "invite_required", code: 403 };
  };
  await f.engine().tick();
  assert.deepEqual(f.calls, ["get_group_info", "add_participant"]);
  assert.equal((f.db.prepare("SELECT membership_state FROM customers WHERE person_id=2").get() as any).membership_state, "review");
});

for (const code of [429, 463]) test(`restriction ${code} durably pauses all additions without a timed resume`, async t => {
  const f = fixture(t);
  f.db.prepare("UPDATE companies SET pause_until='2099-01-01T00:00:00.000Z'").run();
  f.wa.call = async (_id: string, action: string) => {
    f.calls.push(action);
    return action === "get_group_info" ? { participantCount: 3 } : { status: "account_restricted", code };
  };
  await f.engine().tick();
  assert.deepEqual(f.db.prepare("SELECT paused,pause_until FROM companies WHERE id=?").get(f.id), { paused: 1, pause_until: null });
  f.advance(86400001);
  await f.engine().tick();
  assert.deepEqual(f.calls, ["get_group_info", "add_participant"]);
});

test("a restriction discovered at the worker gate leaves the customer pending and permits one later attempt", async t => {
  const f = fixture(t);
  let blocked = true;
  f.wa.call = async (_id: string, action: string) => {
    f.calls.push(action);
    return action === "get_group_info" ? { participantCount: 3 }
      : blocked ? { status: "account_restricted", attempted: false } : { status: "joined", code: 200 };
  };
  await f.engine().tick();
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM operations").get() as any).n, 0);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM customers WHERE membership_state='not_attempted'").get() as any).n, 3);
  blocked = false;
  f.db.prepare("UPDATE companies SET paused=0").run();
  await f.engine().tick();
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM customers WHERE membership_state='joined'").get() as any).n, 1);
});

test("a connected but processing-blocked session performs no metadata reads or additions", async t => {
  const f = fixture(t);
  f.wa.state.processingBlocked = true;
  await f.engine().tick();
  assert.deepEqual(f.calls, []);
});

test("addition interval introduces deterministic jitter and varies across operations", () => {
  assert.equal(calculateAdditionInterval(0, "test"), 0);
  assert.equal(calculateAdditionInterval(60, null), 60);

  const samples = new Set<number>();
  for (let i = 0; i < 20; i++) {
    const interval = calculateAdditionInterval(60, `comp:2026-11-04T00:${i.toString().padStart(2, "0")}:00.000Z`);
    assert.ok(interval >= 60 && interval <= 90, `Interval ${interval} out of bounds`);
    samples.add(interval);
  }
  // Confirms it's not a static 60s timer and has multiple variable values
  assert.ok(samples.size > 5, `Expected multiple different interval values, got ${samples.size}`);

  // Determinism check: same seed produces identical interval across calls
  const s1 = calculateAdditionInterval(60, "comp:same-seed-time");
  const s2 = calculateAdditionInterval(60, "comp:same-seed-time");
  assert.equal(s1, s2);
});
