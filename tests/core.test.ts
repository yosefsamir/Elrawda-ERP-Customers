import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../packages/storage/database.js";
import { CompanyRepository } from "../packages/storage/company-repository.js";
import {
  cairoDay,
  csvCell,
  selectPhone,
  validateEgyptPhone,
} from "../packages/domain/phone.js";
import type { SourceSnapshot } from "../packages/domain/contracts.js";
import { createApp } from "../apps/server/app.js";

const row = (id: number, phone = "01012345678") => ({
  idprogramitems: 9,
  idbranch: 39,
  idperson: id,
  fperson: "عميل اختبار",
  ftel1: phone,
});
const snapshot = (customers = [row(1)]): SourceSnapshot => ({
  identity: "test-source",
  label: "اختبار",
  branches: [
    { idprogramitems: 9, idbranch: 39, fbranch: "فرع الاختبار", fvis: true },
  ],
  customers,
});
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "emoji-core-"));
  const db = openDatabase(join(dir, "test.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO operators VALUES(?,?,?)").run(
    "owner",
    "owner",
    "test-hash",
  );
  const repo = new CompanyRepository(db),
    company = repo.create("owner", "Emoji Store");
  return { db, repo, company };
}

test("Egyptian numbers, localized digits and foreign numbers are classified without asserting WhatsApp registration", () => {
  assert.equal(validateEgyptPhone("٠١٠١٢٣٤٥٦٧٨").normalized, "201012345678");
  assert.equal(validateEgyptPhone("+20 (10) 1234-5678").state, "valid");
  assert.equal(validateEgyptPhone("00201012345678").state, "valid");
  assert.equal(validateEgyptPhone("+447911123456").state, "not_egyptian");
  assert.equal(validateEgyptPhone("0223456789").state, "invalid");
  assert.equal(validateEgyptPhone("01012345678,01112345678").state, "invalid");
  assert.equal(validateEgyptPhone("").state, "missing");
  assert.equal(selectPhone(["bad", "۰۱۱۱۲۳۴۵۶۷۸"]).field, 2);
});
test("Cairo report day respects local midnight rather than execution host timezone", () => {
  assert.equal(cairoDay(new Date("2026-10-30T23:30:00Z")), "2026-10-31");
});
test("baseline survives repeated sync and only genuinely new keys enter the daily report", (t) => {
  const { repo, company } = fixture(t);
  assert.equal(repo.ingest(company, snapshot(), "snapshot").baseline, true);
  assert.equal(repo.ingest(company, snapshot(), "snapshot").added, 0);
  repo.ingest(company, snapshot([row(1), row(2, "bad")]), "snapshot");
  const daily = repo.report(company, { baseline: false, day: cairoDay() });
  assert.equal(daily.totals.total, 1);
  assert.equal(daily.totals.invalid, 1);
  assert.equal(repo.report(company, { baseline: true }).totals.total, 2);
});
test("branch watermarks track max person id per branch for incremental sync", (t) => {
  const { repo, company } = fixture(t);
  repo.ingest(company, snapshot([row(100), row(105)]), "snapshot");
  const watermarks = repo.getBranchWatermarks(company);
  assert.equal(watermarks[39], 105);

  // Ingesting a delta with only new rows (id > 105)
  const delta = repo.ingest(company, snapshot([row(106)]), "snapshot");
  assert.equal(delta.added, 1);
  assert.equal(repo.getBranchWatermarks(company)[39], 106);
});
test("same ERP identities and phones in two companies remain isolated", (t) => {
  const { repo, company } = fixture(t),
    other = repo.create("owner", "شركة ثانية");
  repo.ingest(company, snapshot(), "snapshot");
  repo.ingest(other, snapshot([row(1), row(2)]), "snapshot");
  assert.equal(repo.report(company, { baseline: true }).totals.total, 1);
  assert.equal(repo.report(other, { baseline: true }).totals.total, 2);
  assert.equal(repo.report(company, { baseline: true }).totals.unchecked, 1);
  assert.equal(
    repo.report(company, { baseline: true }).totals.not_registered,
    0,
  );
});
test("duplicate source keys and a source identity change fail without altering stored customers", (t) => {
  const { repo, company } = fixture(t);
  repo.ingest(company, snapshot(), "snapshot");
  assert.throws(() =>
    repo.ingest(company, snapshot([row(2), row(2)]), "snapshot"),
  );
  assert.throws(() =>
    repo.ingest(
      company,
      { ...snapshot([row(3)]), identity: "other-db" },
      "sql",
    ),
  );
  assert.equal(repo.report(company, { baseline: true }).totals.total, 1);
});
test("phone changes invalidate old registration and membership evidence without changing first discovery", (t) => {
  const { repo, company, db } = fixture(t);
  repo.ingest(company, snapshot(), "snapshot");
  db.prepare(
    "UPDATE customers SET whatsapp_state='registered',membership_state='joined' WHERE company_id=?",
  ).run(company);
  repo.ingest(company, snapshot([row(1, "01112345678")]), "snapshot");
  const current: any = repo.report(company, { baseline: true }).rows[0];
  assert.equal(current.whatsapp_state, "unchecked");
  assert.equal(current.membership_state, "review");
  assert.equal(current.is_baseline, 1);
});
test("CSV protects formula-like values and preserves quotes", () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("normal"), '"normal"');
});
test("HTTP API requires authentication and same-origin mutation headers; bootstrap is one-time", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "emoji-http-"));
  const { app } = await createApp({ root: process.cwd(), dataDir: dir });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (
    method: string,
    url: string,
    payload?: any,
    cookie?: string,
    headers: any = {},
  ) =>
    app.inject({
      method: method as any,
      url,
      headers: {
        host: "localhost",
        "x-emoji-request": "1",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      payload,
    });
  assert.equal((await request("GET", "/api/customers")).statusCode, 401);
  assert.equal(
    (
      await request(
        "POST",
        "/api/auth/bootstrap",
        { username: "admin", password: "LongTestPassword!123" },
        undefined,
        { origin: "https://outside.example" },
      )
    ).statusCode,
    403,
  );
  const bootstrap = await request("POST", "/api/auth/bootstrap", {
    username: "admin",
    password: "LongTestPassword!123",
  });
  assert.equal(bootstrap.statusCode, 200);
  const cookie = bootstrap.cookies[0].name + "=" + bootstrap.cookies[0].value;
  assert.equal(
    (
      await request("POST", "/api/auth/bootstrap", {
        username: "other",
        password: "LongTestPassword!123",
      })
    ).statusCode,
    409,
  );
  const created = await request(
    "POST",
    "/api/companies",
    { name: "Emoji Store" },
    cookie,
  );
  assert.equal(created.statusCode, 200);
  const company = (
    await request("GET", "/api/company", undefined, cookie)
  ).json();
  assert.equal(company.name, "Emoji Store");
  assert.equal(company.runMode, "preview");
  assert.equal(
    (
      await request(
        "POST",
        "/api/company/switch",
        { id: "00000000-0000-4000-8000-000000000000" },
        cookie,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("GET", "/api/company", undefined, cookie, {
        host: "evil.example",
      })
    ).statusCode,
    403,
  );
});
