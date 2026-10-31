import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../packages/storage/database.js";
import { CompanyRepository } from "../packages/storage/company-repository.js";
import { cairoDay } from "../packages/domain/phone.js";
import type { SourceSnapshot } from "../packages/domain/contracts.js";

test("lifecycle: registering new customer in branch appears immediately in incremental delta and daily report", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "test-lifecycle-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Setup operator and company
  db.prepare("INSERT INTO operators VALUES(?,?,?)").run("admin", "admin", "hash");
  const repo = new CompanyRepository(db);
  const companyId = repo.create("admin", "سلسلة الروضة");

  // 2. Initial baseline snapshot with 3 branches
  const initialSnapshot: SourceSnapshot = {
    identity: "sql:test:erp",
    label: "قاعدة الـ ERP",
    branches: [
      { idprogramitems: 9, idbranch: 39, fbranch: "المنصورة", fvis: true },
      { idprogramitems: 9, idbranch: 40, fbranch: "كفر سعد", fvis: true },
      { idprogramitems: 9, idbranch: 41, fbranch: "عمر أفندي", fvis: true },
    ],
    customers: [
      { idprogramitems: 9, idbranch: 39, idperson: 8465, fperson: "عميل قديم 1", ftel1: "01011111111" },
      { idprogramitems: 9, idbranch: 39, idperson: 8466, fperson: "عميل قديم 2", ftel1: "01022222222" },
      { idprogramitems: 9, idbranch: 40, idperson: 2016, fperson: "عميل قديم 3", ftel1: "01033333333" },
    ],
  };

  const initialResult = repo.ingest(companyId, initialSnapshot, "sql");
  assert.equal(initialResult.baseline, true);
  assert.equal(initialResult.added, 3);

  // Check watermarks after baseline
  const watermarks = repo.getBranchWatermarks(companyId);
  assert.equal(watermarks[39], 8466);
  assert.equal(watermarks[40], 2016);
  assert.equal(watermarks[41], undefined);

  // Daily report before new customer: should be 0 because all 3 are baseline!
  const todayReportBefore = repo.report(companyId, { baseline: false, day: cairoDay() });
  assert.equal(todayReportBefore.totals.total, 0);

  // 3. Simulate branch 39 registering a brand new customer in ERP
  const newCustomerRow = {
    idprogramitems: 9,
    idbranch: 39,
    idperson: 8467, // Next sequential ID (> 8466)
    fperson: "أحمد محمود (عميل جديد من فرع المنصورة)",
    ftel1: "01099887766",
  };

  // The incremental query filter (idperson > watermark) returns ONLY this new row
  const incrementalSnapshot: SourceSnapshot = {
    identity: "sql:test:erp",
    label: "قاعدة الـ ERP",
    branches: initialSnapshot.branches,
    customers: [newCustomerRow],
  };

  const incrementalResult = repo.ingest(companyId, incrementalSnapshot, "sql");
  assert.equal(incrementalResult.baseline, false);
  assert.equal(incrementalResult.added, 1);
  assert.equal(incrementalResult.changed, 0);
  assert.equal(incrementalResult.total, 1);

  // 4. Verify customer appears in today's report
  const todayReportAfter = repo.report(companyId, { baseline: false, day: cairoDay() });
  assert.equal(todayReportAfter.totals.total, 1);
  assert.equal(todayReportAfter.totals.valid, 1);

  const customerInDb = todayReportAfter.rows[0] as any;
  assert.equal(customerInDb.person_id, 8467);
  assert.equal(customerInDb.name, "أحمد محمود (عميل جديد من فرع المنصورة)");
  assert.equal(customerInDb.phone, "201099887766");
  assert.equal(customerInDb.phone_state, "valid");
  assert.equal(customerInDb.is_baseline, 0);
  assert.equal(customerInDb.first_day, cairoDay());

  // 5. Watermarks updated
  const watermarksAfter = repo.getBranchWatermarks(companyId);
  assert.equal(watermarksAfter[39], 8467);

  // 6. Next cycle: 0 new customers
  const emptySnapshot: SourceSnapshot = {
    identity: "sql:test:erp",
    label: "قاعدة الـ ERP",
    branches: initialSnapshot.branches,
    customers: [],
  };
  const emptyResult = repo.ingest(companyId, emptySnapshot, "sql");
  assert.equal(emptyResult.added, 0);
  assert.equal(emptyResult.total, 0);
});

test("lifecycle: customer saved without phone then phone entered later is automatically picked up and queued", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "test-late-phone-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  db.prepare("INSERT INTO operators VALUES(?,?,?)").run("admin", "admin", "hash");
  const repo = new CompanyRepository(db);
  const companyId = repo.create("admin", "سلسلة الروضة");

  // 1. Initial baseline
  repo.ingest(
    companyId,
    {
      identity: "sql:test:erp",
      label: "قاعدة الـ ERP",
      branches: [{ idprogramitems: 9, idbranch: 39, fbranch: "المنصورة", fvis: true }],
      customers: [{ idprogramitems: 9, idbranch: 39, idperson: 100, fperson: "قديم", ftel1: "01000000000" }],
    },
    "sql",
  );

  // 2. Cashier registers new customer with name only (no phone entered yet)
  const sync1 = repo.ingest(
    companyId,
    {
      identity: "sql:test:erp",
      label: "قاعدة الـ ERP",
      branches: [{ idprogramitems: 9, idbranch: 39, fbranch: "المنصورة", fvis: true }],
      customers: [{ idprogramitems: 9, idbranch: 39, idperson: 101, fperson: "محمد حسام", ftel1: undefined }],
    },
    "sql",
  );
  assert.equal(sync1.added, 1);

  // Verify customer state: missing phone
  let cust = db.prepare("SELECT * FROM customers WHERE person_id=101").get() as any;
  assert.equal(cust.phone_state, "missing");
  assert.equal(cust.membership_state, "not_attempted");

  // Verify customer is in the pending recheck list
  const pendingRechecks = repo.getPendingRecheckPersonIds(companyId);
  assert.deepEqual(pendingRechecks[39], [101]);

  // 3. Cashier now enters phone number "01012345678" in ERP
  const sync2 = repo.ingest(
    companyId,
    {
      identity: "sql:test:erp",
      label: "قاعدة الـ ERP",
      branches: [{ idprogramitems: 9, idbranch: 39, fbranch: "المنصورة", fvis: true }],
      customers: [{ idprogramitems: 9, idbranch: 39, idperson: 101, fperson: "محمد حسام", ftel1: "01012345678" }],
    },
    "sql",
  );
  assert.equal(sync2.changed, 1);

  // Customer should now be promoted to valid phone and queued for WhatsApp!
  cust = db.prepare("SELECT * FROM customers WHERE person_id=101").get() as any;
  assert.equal(cust.phone, "201012345678");
  assert.equal(cust.phone_state, "valid");
  assert.equal(cust.whatsapp_state, "unchecked");
  assert.equal(cust.membership_state, "not_attempted");

  // And customer is no longer in pending rechecks!
  const pendingRechecksAfter = repo.getPendingRecheckPersonIds(companyId);
  assert.equal(pendingRechecksAfter[39], undefined);
});

