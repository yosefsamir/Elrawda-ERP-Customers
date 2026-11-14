import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeItemLedger,
  computeItemPerformance,
  loadInventorySnapshotFromFile,
  type InventorySnapshot,
} from "../packages/erp/inventory-performance.js";

function makeSyntheticSnapshot(): InventorySnapshot {
  const sources = [
    "gard", "ward", "sadr", "return_s", "return_w",
    "sarf_s", "sarf_w", "trans", "transstorbranch", "manf", "costitemsmanf",
  ];
  return {
    source: "Synthetic test snapshot",
    checkedAt: "2026-10-28T00:00:00.000Z",
    recordsets: [
      sources.map(source => ({
        source,
        all_lines: 1,
        export_until: "2026-10-28 00:00:00.000",
        missing_headers: 0,
        active_lines: 1,
        null_deletion_flags: 0,
      })),
      [
        // Product 100 in Branch 1 Store 10: opening 10, sold 6, return 1 -> closing 5
        {
          source: "gard", idprogramitems: 9, idbranch: 1, idstor: 10, idno_s: 1, line_id: 1,
          iddet: 100, idunit: 1, quantity: 10, bonus: 0,
          movement_date: "2026-08-01 00:00:00.000", manufacturing_closed_date: null,
          destination_branch: null, destination_store: null, destination_product: null,
          changes_product: null, component_direction: null, consignment_flag: null,
        },
        {
          source: "sadr", idprogramitems: 9, idbranch: 1, idstor: 10, idno_s: 2, line_id: 2,
          iddet: 100, idunit: 1, quantity: 6, bonus: 0,
          movement_date: "2026-10-05 12:00:00.000", manufacturing_closed_date: null,
          destination_branch: null, destination_store: null, destination_product: null,
          changes_product: null, component_direction: null, consignment_flag: null,
        },
        {
          source: "return_s", idprogramitems: 9, idbranch: 1, idstor: 10, idno_s: 3, line_id: 3,
          iddet: 100, idunit: 1, quantity: 1, bonus: 0,
          movement_date: "2026-10-10 12:00:00.000", manufacturing_closed_date: null,
          destination_branch: null, destination_store: null, destination_product: null,
          changes_product: null, component_direction: null, consignment_flag: null,
        },
        // Product 200 in Branch 2 Store 20: goes negative before period (-3), then receives +5 -> closing 2 (not 5!)
        {
          source: "sadr", idprogramitems: 9, idbranch: 2, idstor: 20, idno_s: 4, line_id: 4,
          iddet: 200, idunit: 1, quantity: 3, bonus: 0,
          movement_date: "2026-09-15 10:00:00.000", manufacturing_closed_date: null,
          destination_branch: null, destination_store: null, destination_product: null,
          changes_product: null, component_direction: null, consignment_flag: null,
        },
        {
          source: "ward", idprogramitems: 9, idbranch: 2, idstor: 20, idno_s: 5, line_id: 5,
          iddet: 200, idunit: 1, quantity: 5, bonus: 0,
          movement_date: "2026-10-02 10:00:00.000", manufacturing_closed_date: null,
          destination_branch: null, destination_store: null, destination_product: null,
          changes_product: null, component_direction: null, consignment_flag: null,
        },
      ],
      [
        { iddet: 100, code: "A100", section: "قميص", classification: "قطن", size: "L", item_type: "ملابس", service_item: false },
        { iddet: 200, code: "B200", section: "بنطلون", classification: "جينز", size: "32", item_type: "ملابس", service_item: false },
      ],
      [
        { idbranch: 1, branch_name: "الفرع الأول" },
        { idbranch: 2, branch_name: "الفرع الثاني" },
      ],
      [
        { idbranch: 1, idstor: 10, store_name: "مخزن 1" },
        { idbranch: 2, idstor: 20, store_name: "مخزن 2" },
      ],
      [],
    ],
  };
}

test("computeItemPerformance computes balances, negative-as-zero policy, and filters accurately", () => {
  const snapshot = makeSyntheticSnapshot();
  const report = computeItemPerformance(snapshot, {
    baseline: "2026-08-01",
    from: "2026-10-01",
    to: "2026-10-27",
  });

  assert.equal(report.meta.periodDays, 27);
  assert.equal(report.rows.length, 2);

  const row100 = report.rows.find(r => r.productId === "100")!;
  assert.equal(row100.opening, 10);
  assert.equal(row100.sold, 6);
  assert.equal(row100.returnSold, 1);
  assert.equal(row100.netSold, 5);
  assert.equal(row100.closing, 5);
  assert.equal(row100.sellThroughPct, 50);

  // Signed ledger retains -3 prior shortage so +5 inbound yields closing 2 (not 5)
  const row200 = report.rows.find(r => r.productId === "200")!;
  assert.equal(row200.rawOpening, -3);
  assert.equal(row200.opening, 0);
  assert.equal(row200.inbound, 5);
  assert.equal(row200.closing, 2);

  // Filter by branchIds
  const filtered = computeItemPerformance(snapshot, {
    baseline: "2026-08-01",
    from: "2026-10-01",
    to: "2026-10-27",
    branchIds: ["1"],
  });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].productId, "100");
  assert.equal(filtered.summary.totalNetSold, 5);
});

test("computeItemPerformance rejects invalid period boundaries", () => {
  const snapshot = makeSyntheticSnapshot();
  assert.throws(() => computeItemPerformance(snapshot, {
    baseline: "2026-08-01",
    from: "2026-08-01",
    to: "2026-10-27",
  }), /Require baseline < from <= to/);
  assert.throws(() => computeItemPerformance(snapshot, {
    baseline: "2026-08-01",
    from: "2026-10-10",
    to: "2026-10-01",
  }), /Require baseline < from <= to/);
});

const localSnapshotPath = resolve(process.cwd(), "data/database-review/inventory-movements.json");
test("computeItemPerformance matches user-confirmed ERP cases on local snapshot", { skip: !existsSync(localSnapshotPath) }, async () => {
  const snapshot = await loadInventorySnapshotFromFile(localSnapshotPath);
  const report = computeItemPerformance(snapshot, {
    baseline: "2026-08-01",
    from: "2026-10-01",
    to: "2026-10-27",
    branchIds: ["39"],
    productIds: ["186759", "187754"],
  });

  const z3330 = report.rows.find(r => r.productId === "186759" && r.storeId === "28");
  assert.ok(z3330, "Expected Z3330 in branch 39 store 28");
  assert.equal(z3330.opening, 4);
  assert.equal(z3330.transferIn, 0);
  assert.equal(z3330.sold, 2);
  assert.equal(z3330.returnSold, 0);
  assert.equal(z3330.closing, 2);
  assert.equal(z3330.sellThroughPct, 50);
  assert.equal(z3330.availableDays, 27);

  const h2025 = report.rows.find(r => r.productId === "187754" && r.storeId === "28");
  assert.ok(h2025, "Expected H2025 in branch 39 store 28");
  assert.equal(h2025.opening, 84);
  assert.equal(h2025.transferIn, 71);
  assert.equal(h2025.sold, 55);
  assert.equal(h2025.returnSold, 1);
  assert.equal(h2025.netSold, 54);
  assert.equal(h2025.closing, 101);
});

test("computeItemLedger returns chronological movements and running balance", () => {
  const snapshot = makeSyntheticSnapshot();
  const ledger = computeItemLedger(snapshot, {
    baseline: "2026-08-01",
    from: "2026-10-01",
    to: "2026-10-27",
    branchId: "1",
    storeId: "10",
    productId: "100",
  });

  assert.equal(ledger.opening, 10);
  assert.equal(ledger.totalInbound, 1);
  assert.equal(ledger.totalOutbound, 6);
  assert.equal(ledger.closing, 5);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries[0].label, "بيع");
  assert.equal(ledger.entries[0].outbound, 6);
  assert.equal(ledger.entries[0].balanceAfter, 4);
  assert.equal(ledger.entries[1].label, "مرتجع بيع");
  assert.equal(ledger.entries[1].inbound, 1);
  assert.equal(ledger.entries[1].balanceAfter, 5);
});
