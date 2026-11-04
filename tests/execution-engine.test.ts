import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../packages/storage/database.js";
import { CompanyRepository } from "../packages/storage/company-repository.js";
import { ExecutionEngine } from "../apps/server/execution-engine.js";
import { cairoDay } from "../packages/domain/phone.js";

function setupFixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  db.prepare("INSERT INTO operators VALUES(?,?,?)").run("admin", "admin", "hash");
  const repo = new CompanyRepository(db);
  const companyId = repo.create("admin", "الروضة");
  // These cases isolate routing/idempotency; pacing has its own clocked tests.
  db.prepare("UPDATE companies SET settings=? WHERE id=?")
    .run(JSON.stringify({ ...repo.settings(companyId), additionMinIntervalSeconds: 0 }), companyId);

  // Enable live mode and unpause
  db.prepare("UPDATE companies SET paused = 0, run_mode = 'live' WHERE id = ?").run(companyId);

  // Setup branch with group
  db.prepare(`
    INSERT INTO branches(company_id, program_id, branch_id, name, enabled, group_id, base_name, next_counter)
    VALUES(?, 9, 39, 'المنصورة', 1, '120363000000000001@g.us', 'الروضة — المنصورة', 2)
  `).run(companyId);

  return { db, repo, companyId };
}

test("ExecutionEngine: new customer is processed immediately regardless of working hours", async (t) => {
  const { db, repo, companyId } = setupFixture(t);

  // Set working hours to a time guaranteed NOT to match current Cairo time to prove new customer bypasses it
  const settings = repo.settings(companyId);
  settings.workStart = "03:00";
  settings.workEnd = "03:01";
  settings.historicalDailyLimit = 10;
  db.prepare("UPDATE companies SET settings = ? WHERE id = ?").run(JSON.stringify(settings), companyId);

  // Insert a new customer (is_baseline = 0)
  db.prepare(`
    INSERT INTO customers(company_id, program_id, branch_id, person_id, name, raw_phone, phone, phone_state, phone_reason, phone_field, first_seen, first_day, is_baseline, fingerprint)
    VALUES(?, 9, 39, 9001, 'عميل جديد', '01012345678', '201012345678', 'valid', 'صحيح', 1, datetime('now'), ?, 0, 'fp1')
  `).run(companyId, cairoDay());

  const mockCalls: Array<{ action: string; payload: any }> = [];
  const mockWa: any = {
    state: { companyId, status: "ready" },
    async call(cid: string, action: string, payload: any) {
      mockCalls.push({ action, payload });
      if (action === "get_group_info") {
        return { participantCount: 150 };
      }
      if (action === "add_participant") {
        return { status: "joined", code: 200 };
      }
      return {};
    },
  };

  const engine = new ExecutionEngine(db, repo, mockWa as any);
  await engine.tick();

  // Verify addition was executed
  const addCall = mockCalls.find((c) => c.action === "add_participant");
  assert.ok(addCall, "Expected add_participant to be called for new customer");
  assert.equal(addCall?.payload.phone, "201012345678");

  // Verify customer state updated to joined
  const customer: any = db.prepare("SELECT * FROM customers WHERE company_id = ? AND person_id = 9001").get(companyId);
  assert.equal(customer.membership_state, "joined");
  assert.equal(customer.whatsapp_state, "registered");

  // Verify daily usage for historical customers was NOT incremented
  const dailyUsage = repo.getDailyUsage(companyId, cairoDay());
  assert.equal(dailyUsage, 0, "New customers must not consume historical daily quota");
});

test("ExecutionEngine: privacy refusal (403) sets state to review without sending 1:1 messages", async (t) => {
  const { db, repo, companyId } = setupFixture(t);

  // Set working hours to cover all day so historical customer is allowed
  const settings = repo.settings(companyId);
  settings.workStart = "00:00";
  settings.workEnd = "23:59";
  settings.historicalDailyLimit = 50;
  db.prepare("UPDATE companies SET settings = ? WHERE id = ?").run(JSON.stringify(settings), companyId);

  // Insert a historical customer (is_baseline = 1)
  db.prepare(`
    INSERT INTO customers(company_id, program_id, branch_id, person_id, name, raw_phone, phone, phone_state, phone_reason, phone_field, first_seen, first_day, is_baseline, fingerprint)
    VALUES(?, 9, 39, 5001, 'عميل قديم', '01198765432', '201198765432', 'valid', 'صحيح', 1, datetime('now'), ?, 1, 'fp2')
  `).run(companyId, cairoDay());

  const mockCalls: Array<{ action: string; payload: any }> = [];
  const mockWa: any = {
    state: { companyId, status: "ready" },
    async call(cid: string, action: string, payload: any) {
      mockCalls.push({ action, payload });
      if (action === "get_group_info") {
        return { participantCount: 200 };
      }
      if (action === "add_participant") {
        return { status: "invite_required", code: 403 };
      }
      return {};
    },
  };

  const engine = new ExecutionEngine(db, repo, mockWa as any);
  await engine.tick();

  // Verify get_invite_link and send_message were NOT called
  assert.equal(mockCalls.find((c) => c.action === "get_invite_link"), undefined);
  assert.equal(mockCalls.find((c) => c.action === "send_message"), undefined);

  // Verify customer state updated to review
  const customer: any = db.prepare("SELECT * FROM customers WHERE company_id = ? AND person_id = 5001").get(companyId);
  assert.equal(customer.membership_state, "review");

  // Verify daily usage for historical was recorded
  const dailyUsage = repo.getDailyUsage(companyId, cairoDay());
  assert.equal(dailyUsage, 1);
});

test("ExecutionEngine: group rollover triggers next group creation when threshold is reached", async (t) => {
  const { db, repo, companyId } = setupFixture(t);

  const settings = repo.settings(companyId);
  settings.workStart = "00:00";
  settings.workEnd = "23:59";
  settings.historicalDailyLimit = 50;
  settings.rolloverThreshold = 950;
  db.prepare("UPDATE companies SET settings = ? WHERE id = ?").run(JSON.stringify(settings), companyId);

  // Insert a customer
  db.prepare(`
    INSERT INTO customers(company_id, program_id, branch_id, person_id, name, raw_phone, phone, phone_state, phone_reason, phone_field, first_seen, first_day, is_baseline, fingerprint)
    VALUES(?, 9, 39, 6001, 'عميل الرول أوفر', '01233334444', '201233334444', 'valid', 'صحيح', 1, datetime('now'), ?, 0, 'fp3')
  `).run(companyId, cairoDay());

  const mockCalls: Array<{ action: string; payload: any }> = [];
  const mockWa: any = {
    state: { companyId, status: "ready" },
    async call(cid: string, action: string, payload: any) {
      mockCalls.push({ action, payload });
      if (action === "get_group_info") {
        return { participantCount: 955 }; // >= rolloverThreshold (950)
      }
      if (action === "create_group") {
        return { groupId: "120363000000000002@g.us" };
      }
      if (action === "add_participant") {
        return { status: "joined", code: 200 };
      }
      return {};
    },
  };

  const engine = new ExecutionEngine(db, repo, mockWa as any);
  await engine.tick();

  // Verify create_group was called with rollover title
  const createCall = mockCalls.find((c) => c.action === "create_group");
  assert.ok(createCall, "Expected create_group to be triggered by rollover");
  assert.equal(createCall?.payload.title, "الروضة — المنصورة 2");

  // Verify branch was updated with new group ID and next_counter = 3
  const branch: any = db.prepare("SELECT * FROM branches WHERE company_id = ? AND branch_id = 39").get(companyId);
  assert.equal(branch.group_id, "120363000000000002@g.us");
  assert.equal(branch.next_counter, 3);

  // Verify participant was added to the NEW group
  const addCall = mockCalls.find((c) => c.action === "add_participant");
  assert.equal(addCall?.payload.groupId, "120363000000000002@g.us");
});

test("ExecutionEngine: historical backlog customers are processed strictly from NEWEST to OLDEST (person_id DESC)", async (t) => {
  const { db, repo, companyId } = setupFixture(t);

  const settings = repo.settings(companyId);
  settings.workStart = "00:00";
  settings.workEnd = "23:59";
  settings.historicalDailyLimit = 50;
  db.prepare("UPDATE companies SET settings = ? WHERE id = ?").run(JSON.stringify(settings), companyId);

  // Insert two historical customers on branch 39: person 100 (oldest) and person 8466 (newest)
  db.prepare(`
    INSERT INTO customers(company_id, program_id, branch_id, person_id, name, raw_phone, phone, phone_state, phone_reason, phone_field, first_seen, first_day, is_baseline, fingerprint)
    VALUES(?, 9, 39, 100, 'عميل قديم جدا', '01011111111', '201011111111', 'valid', 'صحيح', 1, datetime('now'), ?, 1, 'fp_old')
  `).run(companyId, cairoDay());

  db.prepare(`
    INSERT INTO customers(company_id, program_id, branch_id, person_id, name, raw_phone, phone, phone_state, phone_reason, phone_field, first_seen, first_day, is_baseline, fingerprint)
    VALUES(?, 9, 39, 8466, 'أحدث عميل في الفرع', '01099999999', '201099999999', 'valid', 'صحيح', 1, datetime('now'), ?, 1, 'fp_new')
  `).run(companyId, cairoDay());

  const mockCalls: Array<{ action: string; payload: any }> = [];
  const mockWa: any = {
    state: { companyId, status: "ready" },
    async call(cid: string, action: string, payload: any) {
      mockCalls.push({ action, payload });
      if (action === "get_group_info") return { participantCount: 100 };
      if (action === "add_participant") return { status: "joined", code: 200 };
      return {};
    },
  };

  const engine = new ExecutionEngine(db, repo, mockWa as any);
  await engine.tick();

  // Must select person 8466 first (newest!)
  const addCall = mockCalls.find((c) => c.action === "add_participant");
  assert.equal(
    addCall?.payload.phone,
    "201099999999",
    "Expected the newest customer (8466) to be processed before the older customer (100)",
  );

  const newestCustomer: any = db
    .prepare("SELECT membership_state FROM customers WHERE company_id = ? AND person_id = 8466")
    .get(companyId);
  const oldestCustomer: any = db
    .prepare("SELECT membership_state FROM customers WHERE company_id = ? AND person_id = 100")
    .get(companyId);

  assert.equal(newestCustomer.membership_state, "joined");
  assert.equal(
    oldestCustomer.membership_state,
    "not_attempted",
    "Old customer should still be waiting",
  );
});

test("ExecutionEngine: global distribution mode directs all branches to single global group", async (t) => {
  const { db, repo, companyId } = setupFixture(t);

  // Configure company for global distribution mode
  const settings = {
    ...repo.settings(companyId),
    distributionMode: "global" as const,
    globalGroupId: "global-group-jid@g.us",
    globalGroupTitle: "جروب عملاء الروضة العام",
  };
  db.prepare("UPDATE companies SET settings = ? WHERE id = ?").run(
    JSON.stringify(settings),
    companyId,
  );

  // Enable branch without a branch-specific group_id
  db.prepare(
    "UPDATE branches SET enabled = 1, group_id = NULL WHERE company_id = ? AND branch_id = 39",
  ).run(companyId);

  // Seed a customer for branch 39
  db.prepare(`
    INSERT INTO customers(company_id, program_id, branch_id, person_id, name, raw_phone, phone, phone_state, phone_reason, phone_field, first_seen, first_day, is_baseline, fingerprint)
    VALUES(?, 9, 39, 999, 'عميل تجربة', '01011112222', '201011112222', 'valid', 'صحيح', 1, datetime('now'), ?, 0, 'fpglobal')
  `).run(companyId, cairoDay());

  const mockCalls: any[] = [];
  const mockWa = {
    state: { companyId, status: "ready" },
    call: async (_cid: string, action: string, payload: any) => {
      mockCalls.push({ action, payload });
      if (action === "get_group_info") return { participantCount: 50 };
      if (action === "add_participant") return { status: "joined", code: 200 };
      return {};
    },
  };

  const engine = new ExecutionEngine(db, repo, mockWa as any);
  await engine.tick();

  const addCall = mockCalls.find((c) => c.action === "add_participant");
  assert.ok(addCall, "Expected add_participant to be called");
  assert.equal(addCall?.payload.groupId, "global-group-jid@g.us");
  assert.equal(addCall?.payload.phone, "201011112222");
});


