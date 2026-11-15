import test from "node:test";
import assert from "node:assert/strict";
import {
  computeTransferPlan,
  DEFAULT_TRANSFER_SETTINGS,
  sanitizeTransferSettings,
  type TransferSettings,
} from "../apps/reports/src/features/stock-transfers/model.js";
import type { ItemPerformanceRow } from "../apps/reports/src/shared/api/reports.js";

// Pre-hysteresis behaviour: thresholds equal to the target and no minimum line/route sizes.
// Used by the original scenarios so they keep testing the allocation logic in isolation.
const LEGACY_SETTINGS: TransferSettings = {
  ...DEFAULT_TRANSFER_SETTINGS,
  receiveBelowCoverDays: DEFAULT_TRANSFER_SETTINGS.targetCoverDays,
  sendAboveCoverDays: DEFAULT_TRANSFER_SETTINGS.targetCoverDays,
  minLineQty: 1,
  minRouteQty: 0,
};

function makeRow(overrides: Partial<ItemPerformanceRow>): ItemPerformanceRow {
  const closing = overrides.closing ?? 10;
  return {
    programId: "9",
    branchId: "1",
    branchName: "فرع 1",
    storeId: "1",
    storeName: "مخزن 1",
    productId: "p1",
    code: "1001",
    itemType: "ملابس",
    section: "شتوي",
    classification: "تيشيرت",
    description: "تيشيرت شتوي M",
    serviceItem: false,
    opening: 10,
    rawOpening: 10,
    inbound: 0,
    transferIn: 0,
    sold: 0,
    returnSold: 0,
    netSold: 0,
    transferOut: 0,
    otherMovements: 0,
    closing,
    rawClosing: overrides.rawClosing ?? closing,
    sellThroughPct: 0,
    availableDays: 10,
    periodDays: 10,
    ratePerDay: null,
    coverDays: null,
    hasExtraMovements: false,
    ...overrides,
  };
}

test("computeTransferPlan prioritizes stagnant stock then high-cover surplus for shortage branches", () => {
  const rows: ItemPerformanceRow[] = [
    // Branch A (Needer): sells 1/day (10 in 10 days), closing 2 -> needs 14 - 2 = 12
    makeRow({
      branchId: "A",
      branchName: "المعادي",
      netSold: 10,
      sold: 10,
      availableDays: 10,
      closing: 2,
      ratePerDay: 1,
      coverDays: 2,
    }),
    // Branch B (Zero-sales donor): 0 sold, closing 7 -> 7 surplus
    makeRow({
      branchId: "B",
      branchName: "المهندسين",
      netSold: 0,
      availableDays: 10,
      closing: 7,
      ratePerDay: null,
      coverDays: null,
    }),
    // Branch C (Overstocked donor): sells 0.2/day (2 in 10 days), closing 20 -> needs ceil(0.2*14)=3 -> 17 surplus
    makeRow({
      branchId: "C",
      branchName: "مدينة نصر",
      netSold: 2,
      sold: 2,
      availableDays: 10,
      closing: 20,
      ratePerDay: 0.2,
      coverDays: 100,
    }),
  ];

  const plan = computeTransferPlan(rows, LEGACY_SETTINGS);
  assert.equal(plan.totalSuggestions, 2);
  assert.equal(plan.totalQuantity, 12);
  assert.equal(plan.routeCount, 2);

  const fromB = plan.suggestions.find(s => s.fromBranchId === "B");
  const fromC = plan.suggestions.find(s => s.fromBranchId === "C");
  assert.ok(fromB);
  assert.ok(fromC);
  assert.equal(fromB.quantity, 7);
  assert.equal(fromB.fromReason, "راكد");
  assert.equal(fromC.quantity, 5);
  assert.equal(fromC.fromReason, "فائض تغطية");
});

test("computeTransferPlan aggregates multi-store branches before evaluating shortage", () => {
  const rows: ItemPerformanceRow[] = [
    // Branch A Store 1 has 0 closing, Store 2 has 25 closing -> combined 25 for 1/day = 25 days cover (NOT a shortage)
    makeRow({
      branchId: "A",
      branchName: "المعادي",
      storeId: "1",
      netSold: 10,
      availableDays: 10,
      closing: 0,
    }),
    makeRow({
      branchId: "A",
      branchName: "المعادي",
      storeId: "2",
      netSold: 0,
      availableDays: 10,
      closing: 25,
    }),
    makeRow({
      branchId: "B",
      branchName: "المهندسين",
      netSold: 0,
      availableDays: 10,
      closing: 10,
    }),
  ];

  const plan = computeTransferPlan(rows, LEGACY_SETTINGS);
  assert.equal(plan.totalSuggestions, 0);
});

test("computeTransferPlan respects branchRoles, ignores service rows, and keeps hasExtraMovements rows", () => {
  const rows: ItemPerformanceRow[] = [
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "المعادي",
      netSold: 10,
      availableDays: 10,
      closing: 1,
      hasExtraMovements: true,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المخزن الرئيسي",
      netSold: 0,
      availableDays: 10,
      closing: 20,
      hasExtraMovements: true,
    }),
    makeRow({
      productId: "p1",
      branchId: "C",
      branchName: "مستبعد",
      netSold: 0,
      availableDays: 10,
      closing: 50,
    }),
    // Service item should be ignored
    makeRow({
      productId: "svc1",
      serviceItem: true,
      branchId: "A",
      netSold: 10,
      availableDays: 10,
      closing: 0,
    }),
    makeRow({
      productId: "svc1",
      serviceItem: true,
      branchId: "B",
      netSold: 0,
      availableDays: 10,
      closing: 20,
    }),
  ];

  const plan = computeTransferPlan(rows, {
    ...LEGACY_SETTINGS,
    branchRoles: {
      A: "receive_only",
      B: "send_only",
      C: "excluded",
    },
  });

  assert.equal(plan.totalSuggestions, 1);
  assert.equal(plan.suggestions[0]?.fromBranchId, "B");
  assert.equal(plan.suggestions[0]?.toBranchId, "A");
  assert.equal(plan.suggestions[0]?.quantity, 13);
});

test("computeTransferPlan sums rawClosing across branch stores and excludes branch only if combined rawClosing < 0", () => {
  const rows: ItemPerformanceRow[] = [
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "المعادي",
      netSold: 10,
      availableDays: 10,
      closing: 1,
      rawClosing: 1,
    }),
    // Branch B has Store 1 with rawClosing=10, and Store 2 with rawClosing=-2 -> net branch rawClosing = +8
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المهندسين",
      storeId: "1",
      netSold: 0,
      availableDays: 10,
      closing: 10,
      rawClosing: 10,
      hasExtraMovements: false,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المهندسين",
      storeId: "2",
      netSold: 0,
      availableDays: 10,
      closing: 0,
      rawClosing: -2,
      hasExtraMovements: true,
    }),
    // Branch C has net negative rawClosing (-4) -> excluded
    makeRow({
      productId: "p1",
      branchId: "C",
      branchName: "طنطا",
      storeId: "1",
      netSold: 10,
      availableDays: 10,
      closing: 0,
      rawClosing: -4,
      hasExtraMovements: true,
    }),
  ];

  const plan = computeTransferPlan(rows, LEGACY_SETTINGS);
  assert.equal(plan.totalSuggestions, 1);
  assert.equal(plan.suggestions[0]?.fromBranchId, "B");
  assert.equal(plan.suggestions[0]?.toBranchId, "A");
  assert.equal(plan.suggestions[0]?.fromClosing, 8);
  assert.equal(plan.suggestions[0]?.quantity, 8);
});

test("computeTransferPlan protects recent inbound within newStockGraceDays and retains donor cover", () => {
  // Scenario 1: Branch B had 1 piece at start of month, 0 sales, and received 40 pieces 2 days ago (closing=41)
  // Only the 1 mature piece should be pulled, protecting the 40 new pieces!
  const rows1: ItemPerformanceRow[] = [
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "المعادي",
      netSold: 15,
      availableDays: 15,
      closing: 0,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المهندسين",
      opening: 1,
      rawOpening: 1,
      inbound: 40,
      netSold: 0,
      availableDays: 30,
      closing: 41,
      rawClosing: 41,
      inboundByDaysAgo: [{ daysAgo: 2, qty: 40 }],
    }),
  ];

  const plan1 = computeTransferPlan(rows1, {
    ...LEGACY_SETTINGS,
    newStockGraceDays: 7,
  });
  assert.equal(plan1.totalSuggestions, 1);
  assert.equal(plan1.suggestions[0]?.quantity, 1);
  assert.equal(plan1.suggestions[0]?.fromReason, "راكد");

  // Scenario 2: Branch B had 20 at start of month, sold 19, 1 mature piece left, and received 40 pieces 2 days ago (closing=41)
  // Branch B's mature stock (1) is less than its 14-day need, and its 40 new pieces are protected -> 0 pulled from B!
  const rows2: ItemPerformanceRow[] = [
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "المعادي",
      netSold: 15,
      availableDays: 15,
      closing: 0,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المهندسين",
      opening: 20,
      rawOpening: 20,
      inbound: 40,
      sold: 19,
      netSold: 19,
      availableDays: 30,
      closing: 41,
      rawClosing: 41,
      inboundByDaysAgo: [{ daysAgo: 2, qty: 40 }],
    }),
  ];

  const plan2 = computeTransferPlan(rows2, {
    ...LEGACY_SETTINGS,
    newStockGraceDays: 7,
  });
  assert.equal(plan2.totalSuggestions, 0);

  // Scenario 3: Branch B had 50 mature pieces and sold only 2 in 30 days (rate = 2/30/day -> 14-day need = ceil(28/30) = 1 piece)
  // Donor B keeps only its requiredQty (1 piece) and can send up to 47 pieces!
  const rows3: ItemPerformanceRow[] = [
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "المعادي",
      netSold: 40,
      availableDays: 10,
      closing: 0,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المهندسين",
      opening: 50,
      rawOpening: 50,
      sold: 2,
      netSold: 2,
      availableDays: 30,
      closing: 48,
      rawClosing: 48,
    }),
  ];

  const plan3 = computeTransferPlan(rows3, {
    ...LEGACY_SETTINGS,
    newStockGraceDays: 7,
  });
  assert.equal(plan3.totalSuggestions, 1);
  assert.equal(plan3.suggestions[0]?.quantity, 47); // Needer A needs 4*14 = 56, Donor B has 48 - 1 = 47 available
});

test("computeTransferPlan floors effective rate denominator to 7 days (up to periodDays) to prevent 1-day velocity spikes", () => {
  const rows: ItemPerformanceRow[] = [
    // Branch A sold 2 pieces on Day 1 and was out of stock for 29 days (availableDays=1, periodDays=30)
    // Rate should be 2 / 7 = 0.2857/day -> targetQty for 14 days = ceil(2/7 * 14) = 4 pieces (NOT 2/1 * 14 = 28 pieces!)
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "طنطا",
      netSold: 2,
      sold: 2,
      availableDays: 1,
      periodDays: 30,
      closing: 0,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المخزن الرئيسي",
      netSold: 0,
      availableDays: 30,
      periodDays: 30,
      closing: 50,
    }),
  ];

  const plan = computeTransferPlan(rows, LEGACY_SETTINGS);
  assert.equal(plan.totalSuggestions, 1);
  assert.equal(plan.suggestions[0]?.quantity, 4);
});

test("hysteresis: branches between the receive and send thresholds are left alone", () => {
  // Defaults: receive below 7 days, refill to 14, send above 28.
  const rows: ItemPerformanceRow[] = [
    // A: 1/day, closing 10 -> 10 days cover (above 7) -> not short
    makeRow({ branchId: "A", branchName: "المعادي", netSold: 10, closing: 10 }),
    // B: 1/day, closing 20 -> 20 days cover (below 28) -> not a donor
    makeRow({ branchId: "B", branchName: "المهندسين", netSold: 10, closing: 20 }),
  ];
  assert.equal(computeTransferPlan(rows, DEFAULT_TRANSFER_SETTINGS).totalSuggestions, 0);

  // Once A drops below 7 days and B exceeds 28 days, A is refilled up to 14 and B keeps 14.
  const rows2: ItemPerformanceRow[] = [
    makeRow({ branchId: "A", branchName: "المعادي", netSold: 10, closing: 4 }),
    makeRow({ branchId: "B", branchName: "المهندسين", netSold: 10, closing: 30 }),
  ];
  const plan = computeTransferPlan(rows2, DEFAULT_TRANSFER_SETTINGS);
  assert.equal(plan.totalSuggestions, 1);
  assert.equal(plan.suggestions[0]?.fromBranchId, "B");
  assert.equal(plan.suggestions[0]?.quantity, 10);
  assert.equal(plan.suggestions[0]?.fromReason, "فائض تغطية");
});

test("minLineQty skips tiny lines unless the receiver is completely out of stock", () => {
  const settings: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS, minLineQty: 3, minRouteQty: 0 };
  // A: 0.3/day -> 14-day need = ceil(4.2) = 5; has 2 (cover 6.7 < 7) -> needs 3
  const nonEmpty: ItemPerformanceRow[] = [
    makeRow({ branchId: "A", branchName: "المعادي", netSold: 3, closing: 2 }),
    makeRow({ branchId: "B", branchName: "المهندسين", netSold: 0, closing: 20 }),
  ];
  assert.equal(computeTransferPlan(nonEmpty, settings).suggestions[0]?.quantity, 3);
  // With minLineQty 4 the same 3-piece line is skipped
  assert.equal(computeTransferPlan(nonEmpty, { ...settings, minLineQty: 4 }).totalSuggestions, 0);

  // Empty receiver: A sells 0.1/day -> needs only 2, still sent despite minLineQty 3
  const emptyRows: ItemPerformanceRow[] = [
    makeRow({ branchId: "A", branchName: "المعادي", netSold: 1, closing: 0 }),
    makeRow({ branchId: "B", branchName: "المهندسين", netSold: 0, closing: 20 }),
  ];
  const plan = computeTransferPlan(emptyRows, settings);
  assert.equal(plan.totalSuggestions, 1);
  assert.equal(plan.suggestions[0]?.quantity, 2);
});

test("minRouteQty drops weak routes and re-plans the need from a viable route", () => {
  const rows: ItemPerformanceRow[] = [
    // A: 1/day, empty -> needs 14
    makeRow({ branchId: "A", branchName: "المعادي", netSold: 10, closing: 0 }),
    // B: stagnant, 6 pieces -> preferred first, but its route would carry only 6
    makeRow({ branchId: "B", branchName: "المهندسين", netSold: 0, closing: 6 }),
    // C: slow seller 0.1/day, 40 pieces (cover 400 days) -> surplus 38
    makeRow({ branchId: "C", branchName: "مدينة نصر", netSold: 1, closing: 40 }),
  ];

  const plan = computeTransferPlan(rows, { ...DEFAULT_TRANSFER_SETTINGS, minRouteQty: 7 });
  assert.equal(plan.totalSuggestions, 1);
  assert.equal(plan.suggestions[0]?.fromBranchId, "C");
  assert.equal(plan.suggestions[0]?.quantity, 14);
  assert.equal(plan.skippedRoutes.length, 1);
  assert.equal(plan.skippedRoutes[0]?.routeKey, "B->A");
  assert.equal(plan.skippedRoutes[0]?.totalQuantity, 6);

  // Without a route minimum, the stagnant branch is used first.
  const noMin = computeTransferPlan(rows, { ...DEFAULT_TRANSFER_SETTINGS, minRouteQty: 0 });
  assert.equal(noMin.totalSuggestions, 2);
  assert.equal(noMin.skippedRoutes.length, 0);
  assert.equal(noMin.suggestions.find(s => s.fromBranchId === "B")?.quantity, 6);
  assert.equal(noMin.suggestions.find(s => s.fromBranchId === "C")?.quantity, 8);
});

test("new-stock grace does not apply to send-only branches (central warehouse)", () => {
  const rows: ItemPerformanceRow[] = [
    makeRow({ branchId: "A", branchName: "المعادي", netSold: 10, closing: 0 }),
    // Warehouse received 50 pieces 2 days ago
    makeRow({
      branchId: "W",
      branchName: "المخزن الرئيسي",
      opening: 0,
      rawOpening: 0,
      inbound: 50,
      netSold: 0,
      availableDays: 2,
      closing: 50,
      inboundByDaysAgo: [{ daysAgo: 2, qty: 50 }],
    }),
  ];

  // As a normal branch, the fresh stock is protected -> nothing to send
  assert.equal(computeTransferPlan(rows, DEFAULT_TRANSFER_SETTINGS).totalSuggestions, 0);

  // As send-only, the new arrivals are distributed immediately
  const plan = computeTransferPlan(rows, { ...DEFAULT_TRANSFER_SETTINGS, branchRoles: { W: "send_only" } });
  assert.equal(plan.totalSuggestions, 1);
  assert.equal(plan.suggestions[0]?.fromBranchId, "W");
  assert.equal(plan.suggestions[0]?.quantity, 14);
});

test("sanitizeTransferSettings fills defaults, keeps thresholds ordered, and drops invalid roles", () => {
  const s = sanitizeTransferSettings({
    targetCoverDays: 14,
    receiveBelowCoverDays: 20,
    sendAboveCoverDays: 5,
    minLineQty: 0,
    branchRoles: { A: "send_only", B: "bogus" as never },
  });
  assert.equal(s.receiveBelowCoverDays, 14);
  assert.equal(s.sendAboveCoverDays, 14);
  assert.equal(s.minLineQty, 1);
  assert.equal(s.minRouteQty, DEFAULT_TRANSFER_SETTINGS.minRouteQty);
  assert.equal(s.newStockGraceDays, DEFAULT_TRANSFER_SETTINGS.newStockGraceDays);
  assert.deepEqual(s.branchRoles, { A: "send_only" });

  // Garbage / older saved settings fall back to defaults
  assert.deepEqual(sanitizeTransferSettings(null), DEFAULT_TRANSFER_SETTINGS);
  assert.deepEqual(
    sanitizeTransferSettings({ targetCoverDays: 14, newStockGraceDays: 7, branchRoles: {} }),
    DEFAULT_TRANSFER_SETTINGS,
  );
});
