import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReportsPreview } from "../apps/server/reports/index.js";

test("filter preview serves only its own static namespace and doesn't swallow APIs", async t => {
  const root = await mkdtemp(join(tmpdir(), "report-filter-"));
  await mkdir(join(root, "dist/reports/assets"), { recursive: true });
  await writeFile(join(root, "dist/reports/index.html"), "<html>Filter preview</html>");
  await writeFile(join(root, "dist/reports/assets/preview.js"), "export const preview=true;");
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  app.get("/", () => "Existing product lookup");
  app.get("/manage", () => "Existing photo manager");
  await registerReportsPreview(app, root);
  const redirect = await app.inject("/reports");
  assert.equal(redirect.statusCode, 302); assert.equal(redirect.headers.location, "/reports/");
  assert.match((await app.inject("/reports/")).body, /Filter preview/);
  assert.match((await app.inject("/reports/assets/preview.js")).body, /preview=true/);
  assert.equal((await app.inject("/")).body, "Existing product lookup");
  assert.equal((await app.inject("/manage")).body, "Existing photo manager");
  for (const url of ["/api/reports/unknown", "/reports/missing.js"]) {
    const response = await app.inject(url); assert.equal(response.statusCode, 404);
    assert.doesNotMatch(response.body, /<html>/);
  }
});

test("no preview build means no preview route, rather than breaking portal startup", async t => {
  const root = await mkdtemp(join(tmpdir(), "report-filter-empty-"));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await registerReportsPreview(app, root);
  assert.equal((await app.inject("/reports/")).statusCode, 404);
});


test("catalog preview requires loopback and an explicit readable source; no sample fallback", async t => {
  const root = await mkdtemp(join(tmpdir(), "report-catalog-"));
  await mkdir(join(root, "dist/reports"), { recursive: true });
  await writeFile(join(root, "dist/reports/index.html"), "preview");
  const file = join(root, "catalog.json");
  const data = { nodes: [], locations: [], source: { label: "ERP local snapshot", readAt: new Date().toISOString() }, secret: "must not leak" };
  await writeFile(file, JSON.stringify(data));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await registerReportsPreview(app, root, file);
  const url = "/api/reports/filter-options";
  const local = await app.inject({ url, remoteAddress: "127.0.0.1" });
  assert.equal(local.statusCode, 200); assert.equal(local.headers["cache-control"], "no-store");
  assert.equal(local.json().secret, undefined); assert.equal(local.json().source.label, data.source.label);
  const remote = await app.inject({ url, remoteAddress: "100.64.0.1", headers: { "x-forwarded-for": "127.0.0.1", host: "localhost" } });
  assert.equal(remote.statusCode, 403);
  assert.equal((await app.inject({ url, remoteAddress: "127.0.0.1", headers: { host: "portal.example.ts.net" } })).statusCode, 403);
  assert.equal((await app.inject({ url, remoteAddress: "127.0.0.1", headers: { host: "localhost", "x-forwarded-for": "100.64.0.1" } })).statusCode, 403);
  assert.equal((await app.inject({ url, remoteAddress: "127.0.0.1", headers: { origin: "https://other.example" } })).statusCode, 403);
  await writeFile(file, "invalid");
  assert.equal((await app.inject({ url, remoteAddress: "::1" })).statusCode, 503);
});

test("item-performance preview enforces loopback, validates payload, and returns computed report", async t => {
  const root = await mkdtemp(join(tmpdir(), "report-perf-"));
  await mkdir(join(root, "dist/reports"), { recursive: true });
  await writeFile(join(root, "dist/reports/index.html"), "preview");
  const catalogFile = join(root, "catalog.json");
  await writeFile(catalogFile, JSON.stringify({ nodes: [], locations: [], source: { label: "Test", readAt: new Date().toISOString() } }));

  const sources = [
    "gard", "ward", "sadr", "return_s", "return_w",
    "sarf_s", "sarf_w", "trans", "transstorbranch", "manf", "costitemsmanf",
  ];
  const invFile = join(root, "inventory.json");
  await writeFile(invFile, JSON.stringify({
    source: "Test inventory",
    checkedAt: "2026-10-28T00:00:00.000Z",
    recordsets: [
      sources.map(source => ({ source, all_lines: 1, export_until: "2026-10-28 00:00:00.000", missing_headers: 0, active_lines: 1, null_deletion_flags: 0 })),
      [
        {
          source: "gard", idprogramitems: 9, idbranch: 1, idstor: 10, idno_s: 1, line_id: 1,
          iddet: 100, idunit: 1, quantity: 10, bonus: 0,
          movement_date: "2026-08-01 00:00:00.000", manufacturing_closed_date: null,
          destination_branch: null, destination_store: null, destination_product: null,
          changes_product: null, component_direction: null, consignment_flag: null,
        },
        {
          source: "sadr", idprogramitems: 9, idbranch: 1, idstor: 10, idno_s: 2, line_id: 2,
          iddet: 100, idunit: 1, quantity: 3, bonus: 0,
          movement_date: "2026-10-05 12:00:00.000", manufacturing_closed_date: null,
          destination_branch: null, destination_store: null, destination_product: null,
          changes_product: null, component_direction: null, consignment_flag: null,
        },
      ],
      [{ iddet: 100, code: "A100", section: "قميص", classification: "قطن", size: "L", item_type: "ملابس", service_item: false }],
      [{ idbranch: 1, branch_name: "الفرع الأول" }],
      [{ idbranch: 1, idstor: 10, store_name: "مخزن 1" }],
      [],
    ],
  }));

  const app = Fastify();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await registerReportsPreview(app, root, catalogFile, invFile);

  const url = "/api/reports/item-performance";
  const remote = await app.inject({ method: "POST", url, remoteAddress: "100.64.0.1", payload: { from: "2026-10-01", to: "2026-10-27" } });
  assert.equal(remote.statusCode, 403);

  const badBody = await app.inject({ method: "POST", url, remoteAddress: "127.0.0.1", payload: { from: "invalid", to: "2026-10-27" } });
  assert.equal(badBody.statusCode, 400);

  const ok = await app.inject({ method: "POST", url, remoteAddress: "127.0.0.1", payload: { from: "2026-10-01", to: "2026-10-27" } });
  assert.equal(ok.statusCode, 200);
  const json = ok.json();
  assert.equal(json.summary.totalOpening, 10);
  assert.equal(json.summary.totalNetSold, 3);
  assert.equal(json.summary.totalClosing, 7);
  assert.equal(json.rows.length, 1);

  const ledgerOk = await app.inject({
    method: "POST",
    url: "/api/reports/item-ledger",
    remoteAddress: "127.0.0.1",
    payload: { from: "2026-10-01", to: "2026-10-27", branchId: "1", storeId: "10", productId: "100" },
  });
  assert.equal(ledgerOk.statusCode, 200);
  const ledgerJson = ledgerOk.json();
  assert.equal(ledgerJson.opening, 10);
  assert.equal(ledgerJson.closing, 7);
  assert.equal(ledgerJson.entries.length, 1);
  assert.equal(ledgerJson.entries[0].balanceAfter, 7);
});

test("authenticated reports mode rejects unauthenticated or unauthorized requests and allows permitted users", async t => {
  const root = await mkdtemp(join(tmpdir(), "report-auth-"));
  await mkdir(join(root, "dist/reports"), { recursive: true });
  await writeFile(join(root, "dist/reports/index.html"), "preview");
  const catalogFile = join(root, "catalog.json");
  await writeFile(catalogFile, JSON.stringify({ nodes: [], locations: [], source: { label: "Secure", readAt: new Date().toISOString() } }));

  const app = Fastify();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await registerReportsPreview(app, root, catalogFile, undefined, undefined, false, {
    authorize: request => {
      const role = request.headers["x-test-role"];
      if (!role) return { statusCode: 401, error: "Unauthorized" };
      if (role !== "reports") return { statusCode: 403, error: "Forbidden" };
      return null;
    },
  });

  assert.equal((await app.inject({ url: "/api/reports/filter-options", remoteAddress: "127.0.0.1" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/reports/filter-options", remoteAddress: "127.0.0.1", headers: { "x-test-role": "photo-only" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/reports/item-performance", payload: { from: "2026-08-02", to: "2026-08-02" }, remoteAddress: "127.0.0.1" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/reports/item-ledger", payload: { from: "2026-08-02", to: "2026-08-02", branchId: "1", storeId: "1", productId: "1" }, remoteAddress: "127.0.0.1" })).statusCode, 401);

  const authed = await app.inject({ url: "/api/reports/filter-options", remoteAddress: "203.0.113.10", headers: { "x-test-role": "reports" } });
  assert.equal(authed.statusCode, 200);
  assert.equal(authed.json().source.label, "Secure");
});
