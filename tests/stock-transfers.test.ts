import test from "node:test";
import assert from "node:assert/strict";
import { computeTransferPlan, DEFAULT_TRANSFER_SETTINGS } from "../apps/reports/src/features/stock-transfers/model.js";
import type { ItemPerformanceRow } from "../apps/reports/src/shared/api/reports.js";

function makeRow(overrides: Partial<ItemPerformanceRow>): ItemPerformanceRow {
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
    closing: 10,
    rawClosing: 10,
    sellThroughPct: 0,
    availableDays: 10,
    periodDays: 10,
    ratePerDay: null,
    coverDays: null,
    needsReview: false,
    ...overrides,
  };
}

test("computeTransferPlan prioritizes stagnant stock then high-cover surplus for shortage branches", () => {
  const rows: ItemPerformanceRow[] = [
    // Branch A (Needer): sells 1/day (10 in 10 days), closing 2 -> 2 days cover -> needs 14 - 2 = 12
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
    // Branch B (Stagnant donor): 0 sold, closing 7 -> 7 surplus
    makeRow({
      branchId: "B",
      branchName: "المهندسين",
      netSold: 0,
      availableDays: 10,
      closing: 7,
      ratePerDay: null,
      coverDays: null,
    }),
    // Branch C (Overstocked donor): sells 0.2/day (2 in 10 days), closing 20 -> 100 days cover -> keep ceil(0.2*21)=5 -> 15 surplus
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

  const plan = computeTransferPlan(rows, DEFAULT_TRANSFER_SETTINGS);
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

  const plan = computeTransferPlan(rows, DEFAULT_TRANSFER_SETTINGS);
  assert.equal(plan.totalSuggestions, 0);
});

test("computeTransferPlan respects branchRoles and ignores service/needsReview rows", () => {
  const rows: ItemPerformanceRow[] = [
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "المعادي",
      netSold: 10,
      availableDays: 10,
      closing: 1,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المخزن الرئيسي",
      netSold: 0,
      availableDays: 10,
      closing: 20,
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
    ...DEFAULT_TRANSFER_SETTINGS,
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

test("computeTransferPlan excludes entire branch-product pair if any store has negative or needsReview balance", () => {
  const rows: ItemPerformanceRow[] = [
    makeRow({
      productId: "p1",
      branchId: "A",
      branchName: "المعادي",
      netSold: 10,
      availableDays: 10,
      closing: 1,
    }),
    // Branch B has Store 1 with positive closing=10, and Store 2 with negative closing=-2 (needsReview)
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المهندسين",
      storeId: "1",
      netSold: 0,
      availableDays: 10,
      closing: 10,
      needsReview: false,
    }),
    makeRow({
      productId: "p1",
      branchId: "B",
      branchName: "المهندسين",
      storeId: "2",
      netSold: 0,
      availableDays: 10,
      closing: -2,
      needsReview: true,
    }),
  ];

  const plan = computeTransferPlan(rows, DEFAULT_TRANSFER_SETTINGS);
  assert.equal(plan.totalSuggestions, 0);
});
