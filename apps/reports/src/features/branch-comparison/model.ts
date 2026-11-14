import type { ItemPerformanceRow } from "../../shared/api/reports";

export type BranchComparisonRow = {
  branchId: string;
  branchName: string;
  uniqueProductCount: number;
  rowCount: number;
  zeroSalesCount: number;
  outOfStockCount: number;
  opening: number;
  inbound: number;
  transferIn: number;
  sold: number;
  returnSold: number;
  netSold: number;
  transferOut: number;
  otherMovements: number;
  closing: number;
  sellThroughPct: number | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function aggregateBranches(rows: ItemPerformanceRow[]): BranchComparisonRow[] {
  const byBranch = new Map<
    string,
    {
      branchId: string;
      branchName: string;
      products: Set<string>;
      rowCount: number;
      zeroSalesCount: number;
      outOfStockCount: number;
      opening: number;
      inbound: number;
      transferIn: number;
      sold: number;
      returnSold: number;
      netSold: number;
      transferOut: number;
      otherMovements: number;
      otherInbound: number;
      closing: number;
    }
  >();

  for (const r of rows) {
    let entry = byBranch.get(r.branchId);
    if (!entry) {
      entry = {
        branchId: r.branchId,
        branchName: r.branchName,
        products: new Set<string>(),
        rowCount: 0,
        zeroSalesCount: 0,
        outOfStockCount: 0,
        opening: 0,
        inbound: 0,
        transferIn: 0,
        sold: 0,
        returnSold: 0,
        netSold: 0,
        transferOut: 0,
        otherMovements: 0,
        otherInbound: 0,
        closing: 0,
      };
      byBranch.set(r.branchId, entry);
    }

    entry.products.add(r.productId);
    entry.rowCount += 1;
    if (r.netSold <= 0) entry.zeroSalesCount += 1;
    if (r.closing <= 0) entry.outOfStockCount += 1;
    entry.opening += r.opening;
    entry.inbound += r.inbound;
    entry.transferIn += r.transferIn;
    entry.sold += r.sold;
    entry.returnSold += r.returnSold;
    entry.netSold += r.netSold;
    entry.transferOut += r.transferOut;
    entry.otherMovements += r.otherMovements;
    if (r.otherMovements > 0) entry.otherInbound += r.otherMovements;
    entry.closing += r.closing;
  }

  return [...byBranch.values()].map(b => {
    const denominator = b.opening + b.inbound + b.transferIn + b.otherInbound;
    return {
      branchId: b.branchId,
      branchName: b.branchName,
      uniqueProductCount: b.products.size,
      rowCount: b.rowCount,
      zeroSalesCount: b.zeroSalesCount,
      outOfStockCount: b.outOfStockCount,
      opening: round2(b.opening),
      inbound: round2(b.inbound),
      transferIn: round2(b.transferIn),
      sold: round2(b.sold),
      returnSold: round2(b.returnSold),
      netSold: round2(b.netSold),
      transferOut: round2(b.transferOut),
      otherMovements: round2(b.otherMovements),
      closing: round2(b.closing),
      sellThroughPct: denominator > 0 ? round2((b.netSold * 100) / denominator) : null,
    };
  });
}
