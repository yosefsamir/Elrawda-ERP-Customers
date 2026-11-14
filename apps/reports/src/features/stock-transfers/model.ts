import type { ItemPerformanceRow } from "../../shared/api/reports";

export type BranchTransferRole = "both" | "send_only" | "receive_only" | "excluded";

export type TransferSettings = {
  shortageCoverDays: number;
  targetCoverDays: number;
  surplusCoverDays: number;
  safetyKeepDays: number;
  includeStagnantSurplus: boolean;
  stagnantKeepQty: number;
  branchRoles: Record<string, BranchTransferRole>;
};

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  shortageCoverDays: 5,
  targetCoverDays: 14,
  surplusCoverDays: 30,
  safetyKeepDays: 21,
  includeStagnantSurplus: true,
  stagnantKeepQty: 0,
  branchRoles: {},
};

export type TransferSuggestion = {
  id: string;
  productId: string;
  code: string;
  description: string;
  itemType: string;
  section: string;
  classification: string;
  fromBranchId: string;
  fromBranchName: string;
  fromClosing: number;
  fromNetSold: number;
  fromRatePerDay: number | null;
  fromCoverDays: number | null;
  fromReason: "راكد" | "فائض تغطية";
  toBranchId: string;
  toBranchName: string;
  toClosing: number;
  toNetSold: number;
  toRatePerDay: number;
  toCoverDays: number | null;
  quantity: number;
};

export type TransferRouteGroup = {
  routeKey: string;
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  itemCount: number;
  totalQuantity: number;
  items: TransferSuggestion[];
};

export type TransferPlanSummary = {
  suggestions: TransferSuggestion[];
  routes: TransferRouteGroup[];
  totalSuggestions: number;
  totalQuantity: number;
  uniqueProductCount: number;
  routeCount: number;
};

type BranchProductStat = {
  productId: string;
  code: string;
  description: string;
  itemType: string;
  section: string;
  classification: string;
  branchId: string;
  branchName: string;
  closing: number;
  netSold: number;
  availableDays: number;
  ratePerDay: number;
  coverDays: number | null;
};

function sanitizeSettings(raw: TransferSettings): TransferSettings {
  const shortageCoverDays = Math.max(0, Math.round(raw.shortageCoverDays));
  const targetCoverDays = Math.max(shortageCoverDays + 1, Math.round(raw.targetCoverDays));
  const surplusCoverDays = Math.max(targetCoverDays, Math.round(raw.surplusCoverDays));
  const safetyKeepDays = Math.max(0, Math.min(surplusCoverDays, Math.round(raw.safetyKeepDays)));
  const stagnantKeepQty = Math.max(0, Math.floor(raw.stagnantKeepQty));
  return {
    ...raw,
    shortageCoverDays,
    targetCoverDays,
    surplusCoverDays,
    safetyKeepDays,
    stagnantKeepQty,
  };
}

/**
 * Aggregate store-level performance rows into branch-level totals per product,
 * excluding service items and negative-balance rows that need manual review.
 */
function aggregateByProductAndBranch(rows: ItemPerformanceRow[]): Map<string, BranchProductStat[]> {
  const perBranchKey = new Map<string, BranchProductStat>();
  const taintedBranchProducts = new Set<string>();

  for (const row of rows) {
    if (row.serviceItem) continue;
    const key = `${row.productId}::${row.branchId}`;
    if (row.needsReview || row.closing < 0) {
      taintedBranchProducts.add(key);
      perBranchKey.delete(key);
      continue;
    }
    if (taintedBranchProducts.has(key)) continue;

    const existing = perBranchKey.get(key);
    if (!existing) {
      perBranchKey.set(key, {
        productId: row.productId,
        code: row.code,
        description: row.description,
        itemType: row.itemType,
        section: row.section,
        classification: row.classification,
        branchId: row.branchId,
        branchName: row.branchName,
        closing: row.closing,
        netSold: row.netSold,
        availableDays: row.availableDays,
        ratePerDay: 0,
        coverDays: null,
      });
    } else {
      existing.closing += row.closing;
      existing.netSold += row.netSold;
      existing.availableDays = Math.max(existing.availableDays, row.availableDays);
    }
  }

  const byProduct = new Map<string, BranchProductStat[]>();
  for (const stat of perBranchKey.values()) {
    const rate = stat.netSold > 0 && stat.availableDays > 0 ? stat.netSold / stat.availableDays : 0;
    stat.ratePerDay = rate;
    stat.coverDays = rate > 0 ? Math.max(0, stat.closing) / rate : null;

    const list = byProduct.get(stat.productId);
    if (list) list.push(stat);
    else byProduct.set(stat.productId, [stat]);
  }
  return byProduct;
}

/**
 * Compute stock transfer suggestions across branches from item-performance rows.
 */
export function computeTransferPlan(
  rows: ItemPerformanceRow[],
  rawSettings: TransferSettings = DEFAULT_TRANSFER_SETTINGS,
): TransferPlanSummary {
  const settings = sanitizeSettings(rawSettings);
  const byProduct = aggregateByProductAndBranch(rows);
  const suggestions: TransferSuggestion[] = [];

  for (const branchStats of byProduct.values()) {
    if (branchStats.length < 2) continue;

    type Needer = { stat: BranchProductStat; remainingNeed: number };
    type Donor = { stat: BranchProductStat; remainingSurplus: number; reason: "راكد" | "فائض تغطية" };

    const needers: Needer[] = [];
    const donors: Donor[] = [];

    for (const stat of branchStats) {
      const role = settings.branchRoles[stat.branchId] ?? "both";
      if (role === "excluded") continue;

      const canReceive = role === "both" || role === "receive_only";
      const canSend = role === "both" || role === "send_only";

      // Shortage: active sales and low/zero coverage
      if (
        canReceive &&
        stat.ratePerDay > 0 &&
        (stat.closing <= 0 || (stat.coverDays !== null && stat.coverDays <= settings.shortageCoverDays))
      ) {
        const targetQty = Math.ceil(stat.ratePerDay * settings.targetCoverDays);
        const needed = Math.max(0, targetQty - Math.max(0, Math.floor(stat.closing)));
        if (needed >= 1) {
          needers.push({ stat, remainingNeed: needed });
        }
        continue;
      }

      if (!canSend || stat.closing <= 0) continue;

      // Surplus Case A: stagnant in this branch (zero or negative net sales)
      if (settings.includeStagnantSurplus && stat.netSold <= 0) {
        const surplus = Math.floor(stat.closing - settings.stagnantKeepQty);
        if (surplus >= 1) {
          donors.push({ stat, remainingSurplus: surplus, reason: "راكد" });
        }
        continue;
      }

      // Surplus Case B: high coverage beyond surplus threshold
      if (stat.ratePerDay > 0 && stat.coverDays !== null && stat.coverDays >= settings.surplusCoverDays) {
        const keepQty = Math.ceil(stat.ratePerDay * settings.safetyKeepDays);
        const surplus = Math.floor(stat.closing - keepQty);
        if (surplus >= 1) {
          donors.push({ stat, remainingSurplus: surplus, reason: "فائض تغطية" });
        }
      }
    }

    if (needers.length === 0 || donors.length === 0) continue;

    // Prioritize branches with lowest coverage and highest velocity
    needers.sort((a, b) => {
      const covA = a.stat.coverDays ?? 0;
      const covB = b.stat.coverDays ?? 0;
      if (covA !== covB) return covA - covB;
      return b.stat.ratePerDay - a.stat.ratePerDay;
    });

    // Prioritize stagnant stock first, then highest coverage days, then largest surplus
    donors.sort((a, b) => {
      if (a.reason !== b.reason) return a.reason === "راكد" ? -1 : 1;
      const covA = a.stat.coverDays ?? Number.POSITIVE_INFINITY;
      const covB = b.stat.coverDays ?? Number.POSITIVE_INFINITY;
      if (covA !== covB) return covB - covA;
      return b.remainingSurplus - a.remainingSurplus;
    });

    for (const needer of needers) {
      for (const donor of donors) {
        if (needer.remainingNeed <= 0) break;
        if (donor.remainingSurplus <= 0 || donor.stat.branchId === needer.stat.branchId) continue;

        const qty = Math.min(needer.remainingNeed, donor.remainingSurplus);
        if (qty < 1) continue;

        needer.remainingNeed -= qty;
        donor.remainingSurplus -= qty;

        suggestions.push({
          id: `${donor.stat.branchId}->${needer.stat.branchId}::${needer.stat.productId}`,
          productId: needer.stat.productId,
          code: needer.stat.code,
          description: needer.stat.description,
          itemType: needer.stat.itemType,
          section: needer.stat.section,
          classification: needer.stat.classification,
          fromBranchId: donor.stat.branchId,
          fromBranchName: donor.stat.branchName,
          fromClosing: donor.stat.closing,
          fromNetSold: donor.stat.netSold,
          fromRatePerDay: donor.stat.ratePerDay > 0 ? Number(donor.stat.ratePerDay.toFixed(2)) : null,
          fromCoverDays: donor.stat.coverDays !== null ? Number(donor.stat.coverDays.toFixed(1)) : null,
          fromReason: donor.reason,
          toBranchId: needer.stat.branchId,
          toBranchName: needer.stat.branchName,
          toClosing: needer.stat.closing,
          toNetSold: needer.stat.netSold,
          toRatePerDay: Number(needer.stat.ratePerDay.toFixed(2)),
          toCoverDays: needer.stat.coverDays !== null ? Number(needer.stat.coverDays.toFixed(1)) : null,
          quantity: qty,
        });
      }
    }
  }

  suggestions.sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    return a.description.localeCompare(b.description, "ar");
  });

  const routeMap = new Map<string, TransferRouteGroup>();
  const uniqueProducts = new Set<string>();
  let totalQuantity = 0;

  for (const s of suggestions) {
    uniqueProducts.add(s.productId);
    totalQuantity += s.quantity;
    const routeKey = `${s.fromBranchId}->${s.toBranchId}`;
    const existing = routeMap.get(routeKey);
    if (!existing) {
      routeMap.set(routeKey, {
        routeKey,
        fromBranchId: s.fromBranchId,
        fromBranchName: s.fromBranchName,
        toBranchId: s.toBranchId,
        toBranchName: s.toBranchName,
        itemCount: 1,
        totalQuantity: s.quantity,
        items: [s],
      });
    } else {
      existing.itemCount += 1;
      existing.totalQuantity += s.quantity;
      existing.items.push(s);
    }
  }

  const routes = Array.from(routeMap.values()).sort((a, b) => b.totalQuantity - a.totalQuantity);

  return {
    suggestions,
    routes,
    totalSuggestions: suggestions.length,
    totalQuantity,
    uniqueProductCount: uniqueProducts.size,
    routeCount: routes.length,
  };
}
