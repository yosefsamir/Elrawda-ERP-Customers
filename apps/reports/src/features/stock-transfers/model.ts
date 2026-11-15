import type { ItemPerformanceRow } from "../../shared/api/reports";

export type BranchTransferRole = "both" | "send_only" | "receive_only" | "excluded";

export type TransferSettings = {
  /** Cover (days of sales) a receiving branch is refilled up to, and a donor keeps. */
  targetCoverDays: number;
  /** A selling branch is considered short only when its cover drops below this. */
  receiveBelowCoverDays: number;
  /** A selling branch may donate only when its mature-stock cover exceeds this. */
  sendAboveCoverDays: number;
  /** Recently received stock is protected from being pulled (not applied to send-only branches). */
  newStockGraceDays: number;
  /** Smallest quantity worth a transfer line (waived when the receiver is completely out of stock). */
  minLineQty: number;
  /** Smallest total quantity worth sending on a route; weaker routes are dropped and re-planned. */
  minRouteQty: number;
  branchRoles: Record<string, BranchTransferRole>;
};

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  targetCoverDays: 14,
  receiveBelowCoverDays: 7,
  sendAboveCoverDays: 28,
  newStockGraceDays: 7,
  minLineQty: 3,
  minRouteQty: 10,
  branchRoles: {},
};

const BRANCH_ROLES: readonly BranchTransferRole[] = ["both", "send_only", "receive_only", "excluded"];

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize settings: fill defaults, clamp ranges, and keep the cover thresholds ordered
 * (receiveBelow <= target <= sendAbove) so a branch can never be both short and in surplus.
 */
export function sanitizeTransferSettings(raw: Partial<TransferSettings> | null | undefined): TransferSettings {
  const d = DEFAULT_TRANSFER_SETTINGS;
  const src = raw ?? {};
  const targetCoverDays = Math.max(1, Math.round(finiteOr(src.targetCoverDays, d.targetCoverDays)));
  const receiveBelowCoverDays = Math.min(
    targetCoverDays,
    Math.max(0, Math.round(finiteOr(src.receiveBelowCoverDays, d.receiveBelowCoverDays))),
  );
  const sendAboveCoverDays = Math.max(
    targetCoverDays,
    Math.round(finiteOr(src.sendAboveCoverDays, d.sendAboveCoverDays)),
  );
  const branchRoles: Record<string, BranchTransferRole> = {};
  if (src.branchRoles && typeof src.branchRoles === "object") {
    for (const [id, role] of Object.entries(src.branchRoles)) {
      if (BRANCH_ROLES.includes(role)) branchRoles[id] = role;
    }
  }
  return {
    targetCoverDays,
    receiveBelowCoverDays,
    sendAboveCoverDays,
    newStockGraceDays: Math.max(0, Math.round(finiteOr(src.newStockGraceDays, d.newStockGraceDays))),
    minLineQty: Math.max(1, Math.floor(finiteOr(src.minLineQty, d.minLineQty))),
    minRouteQty: Math.max(0, Math.floor(finiteOr(src.minRouteQty, d.minRouteQty))),
    branchRoles,
  };
}

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

export type SkippedRoute = {
  routeKey: string;
  fromBranchName: string;
  toBranchName: string;
  itemCount: number;
  totalQuantity: number;
};

export type TransferPlanSummary = {
  suggestions: TransferSuggestion[];
  routes: TransferRouteGroup[];
  totalSuggestions: number;
  totalQuantity: number;
  uniqueProductCount: number;
  routeCount: number;
  /** Routes dropped because their total load was below minRouteQty (quantities as measured when dropped). */
  skippedRoutes: SkippedRoute[];
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
  opening: number;
  closing: number;
  netSold: number;
  availableDays: number;
  periodDays: number;
  ratePerDay: number;
  coverDays: number | null;
  inboundByDaysAgo: Array<{ daysAgo: number; qty: number }>;
};

/**
 * Aggregate store-level performance rows into branch-level totals per product,
 * excluding service items and branches whose combined actual closing balance is negative.
 */
function aggregateByProductAndBranch(rows: ItemPerformanceRow[]): Map<string, BranchProductStat[]> {
  const perBranchKey = new Map<string, BranchProductStat>();

  for (const row of rows) {
    if (row.serviceItem) continue;
    const key = `${row.productId}::${row.branchId}`;
    const rowClosing = typeof row.rawClosing === "number" ? row.rawClosing : row.closing;
    const rowOpening = typeof row.rawOpening === "number" ? row.rawOpening : row.opening;

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
        opening: rowOpening,
        closing: rowClosing,
        netSold: row.netSold,
        availableDays: row.availableDays,
        periodDays: row.periodDays || 7,
        ratePerDay: 0,
        coverDays: null,
        inboundByDaysAgo: row.inboundByDaysAgo ? row.inboundByDaysAgo.map(e => ({ ...e })) : [],
      });
    } else {
      existing.opening += rowOpening;
      existing.closing += rowClosing;
      existing.netSold += row.netSold;
      existing.availableDays = Math.max(existing.availableDays, row.availableDays);
      existing.periodDays = Math.max(existing.periodDays, row.periodDays || 7);
      if (row.inboundByDaysAgo) {
        for (const item of row.inboundByDaysAgo) {
          const found = existing.inboundByDaysAgo.find(e => e.daysAgo === item.daysAgo);
          if (found) found.qty += item.qty;
          else existing.inboundByDaysAgo.push({ ...item });
        }
      }
    }
  }

  const byProduct = new Map<string, BranchProductStat[]>();
  for (const stat of perBranchKey.values()) {
    if (stat.closing < 0) continue;
    const effectiveRateDays = Math.max(stat.availableDays, Math.min(7, Math.max(1, stat.periodDays || 7)));
    const rate = stat.netSold > 0 && stat.availableDays > 0 ? stat.netSold / effectiveRateDays : 0;
    stat.ratePerDay = rate;
    stat.coverDays = rate > 0 ? Math.max(0, stat.closing) / rate : null;

    const list = byProduct.get(stat.productId);
    if (list) list.push(stat);
    else byProduct.set(stat.productId, [stat]);
  }
  return byProduct;
}

type Needer = { stat: BranchProductStat; remainingNeed: number; currentClosing: number };
type Donor = {
  stat: BranchProductStat;
  remainingSurplus: number;
  currentClosing: number;
  reason: "راكد" | "فائض تغطية";
};

function routeKeyOf(fromBranchId: string, toBranchId: string): string {
  return `${fromBranchId}->${toBranchId}`;
}

/**
 * Classify one product's branches into needers and donors.
 *
 * Hysteresis: a selling branch receives only when its cover is below receiveBelowCoverDays
 * (and is then refilled up to targetCoverDays); it donates only when the cover of its mature
 * stock exceeds sendAboveCoverDays (and keeps targetCoverDays). Branches in between are left alone,
 * which prevents marginal moves that bounce the same item back and forth week after week.
 */
function classifyBranches(branchStats: BranchProductStat[], settings: TransferSettings) {
  const needers: Needer[] = [];
  const donors: Donor[] = [];

  for (const stat of branchStats) {
    const role = settings.branchRoles[stat.branchId] ?? "both";
    if (role === "excluded") continue;

    const canReceive = role === "both" || role === "receive_only";
    const canSend = role === "both" || role === "send_only";
    const selling = stat.ratePerDay > 0;
    const currentQty = Math.max(0, Math.floor(stat.closing));
    const requiredQty = selling ? Math.ceil(stat.ratePerDay * settings.targetCoverDays) : 0;

    // 1. Needer: selling, and either empty or below the receive threshold.
    if (selling && canReceive) {
      const cover = currentQty / stat.ratePerDay;
      if (currentQty <= 0 || cover < settings.receiveBelowCoverDays) {
        const needed = requiredQty - currentQty;
        if (needed >= 1) {
          needers.push({ stat, remainingNeed: needed, currentClosing: stat.closing });
        }
        continue;
      }
    }

    if (!canSend || stat.closing <= 0) continue;

    // 2. Donor: protect newly arrived stock. Send-only branches (central warehouse) are exempt,
    //    because their new arrivals are exactly what should be distributed.
    let recentInbound = 0;
    if (settings.newStockGraceDays > 0 && role !== "send_only") {
      if (stat.inboundByDaysAgo.length > 0) {
        for (const entry of stat.inboundByDaysAgo) {
          if (entry.daysAgo <= settings.newStockGraceDays) {
            recentInbound += entry.qty;
          }
        }
        if (stat.opening <= 0 && stat.availableDays < settings.newStockGraceDays) {
          recentInbound = Math.max(recentInbound, stat.closing);
        }
      } else if (stat.availableDays < settings.newStockGraceDays) {
        recentInbound = stat.closing;
      }
    }
    const matureClosing = Math.max(0, stat.closing - recentInbound);
    if (matureClosing <= 0) continue;

    // A selling branch donates only when its mature stock clearly exceeds the send threshold.
    if (selling && matureClosing / stat.ratePerDay <= settings.sendAboveCoverDays) continue;

    const surplus = Math.floor(matureClosing - requiredQty);
    if (surplus >= 1) {
      const reason: "راكد" | "فائض تغطية" = stat.netSold <= 0 ? "راكد" : "فائض تغطية";
      donors.push({ stat, remainingSurplus: surplus, currentClosing: stat.closing, reason });
    }
  }

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

  return { needers, donors };
}

function allocate(
  byProduct: Map<string, BranchProductStat[]>,
  settings: TransferSettings,
  bannedRoutes: ReadonlySet<string>,
): TransferSuggestion[] {
  const suggestions: TransferSuggestion[] = [];

  for (const branchStats of byProduct.values()) {
    if (branchStats.length < 2) continue;
    const { needers, donors } = classifyBranches(branchStats, settings);
    if (needers.length === 0 || donors.length === 0) continue;

    for (const needer of needers) {
      for (const donor of donors) {
        if (needer.remainingNeed <= 0) break;
        if (donor.remainingSurplus <= 0 || donor.stat.branchId === needer.stat.branchId) continue;
        if (bannedRoutes.has(routeKeyOf(donor.stat.branchId, needer.stat.branchId))) continue;

        const qty = Math.min(needer.remainingNeed, donor.remainingSurplus);
        if (qty < 1) continue;
        // Small lines are not worth moving, unless the receiver is completely out of a selling item.
        const receiverEmpty = Math.floor(needer.currentClosing) <= 0;
        if (qty < settings.minLineQty && !receiverEmpty) continue;

        const fromClosingBefore = donor.currentClosing;
        const toClosingBefore = needer.currentClosing;
        const fromCoverBefore =
          donor.stat.ratePerDay > 0 ? Number((fromClosingBefore / donor.stat.ratePerDay).toFixed(1)) : null;
        const toCoverBefore =
          needer.stat.ratePerDay > 0 ? Number((toClosingBefore / needer.stat.ratePerDay).toFixed(1)) : null;

        needer.remainingNeed -= qty;
        donor.remainingSurplus -= qty;
        donor.currentClosing -= qty;
        needer.currentClosing += qty;

        suggestions.push({
          id: `${routeKeyOf(donor.stat.branchId, needer.stat.branchId)}::${needer.stat.productId}`,
          productId: needer.stat.productId,
          code: needer.stat.code,
          description: needer.stat.description,
          itemType: needer.stat.itemType,
          section: needer.stat.section,
          classification: needer.stat.classification,
          fromBranchId: donor.stat.branchId,
          fromBranchName: donor.stat.branchName,
          fromClosing: fromClosingBefore,
          fromNetSold: donor.stat.netSold,
          fromRatePerDay: donor.stat.ratePerDay > 0 ? Number(donor.stat.ratePerDay.toFixed(2)) : null,
          fromCoverDays: fromCoverBefore,
          fromReason: donor.reason,
          toBranchId: needer.stat.branchId,
          toBranchName: needer.stat.branchName,
          toClosing: toClosingBefore,
          toNetSold: needer.stat.netSold,
          toRatePerDay: Number(needer.stat.ratePerDay.toFixed(2)),
          toCoverDays: toCoverBefore,
          quantity: qty,
        });
      }
    }
  }

  return suggestions;
}

function groupRoutes(suggestions: TransferSuggestion[]): TransferRouteGroup[] {
  const routeMap = new Map<string, TransferRouteGroup>();
  for (const s of suggestions) {
    const routeKey = routeKeyOf(s.fromBranchId, s.toBranchId);
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
  return Array.from(routeMap.values()).sort((a, b) => b.totalQuantity - a.totalQuantity);
}

const MAX_ROUTE_PASSES = 25;

/**
 * Compute stock transfer suggestions across branches from item-performance rows.
 *
 * Routes whose total load is below minRouteQty are not worth a trip: they are banned and the plan
 * is recomputed, so the affected needs can be served by another (viable) route when possible.
 */
export function computeTransferPlan(
  rows: ItemPerformanceRow[],
  rawSettings: Partial<TransferSettings> = DEFAULT_TRANSFER_SETTINGS,
): TransferPlanSummary {
  const settings = sanitizeTransferSettings(rawSettings);
  const byProduct = aggregateByProductAndBranch(rows);
  const bannedRoutes = new Set<string>();
  const skippedRoutes: SkippedRoute[] = [];

  let suggestions = allocate(byProduct, settings, bannedRoutes);
  let routes = groupRoutes(suggestions);

  for (let pass = 0; settings.minRouteQty > 0; pass++) {
    const weak = routes.filter(r => r.totalQuantity < settings.minRouteQty);
    if (weak.length === 0) break;
    for (const r of weak) {
      bannedRoutes.add(r.routeKey);
      skippedRoutes.push({
        routeKey: r.routeKey,
        fromBranchName: r.fromBranchName,
        toBranchName: r.toBranchName,
        itemCount: r.itemCount,
        totalQuantity: r.totalQuantity,
      });
    }
    if (pass + 1 >= MAX_ROUTE_PASSES) {
      // Safety net: stop re-planning and simply drop the weak routes.
      suggestions = suggestions.filter(s => !bannedRoutes.has(routeKeyOf(s.fromBranchId, s.toBranchId)));
      routes = groupRoutes(suggestions);
      break;
    }
    suggestions = allocate(byProduct, settings, bannedRoutes);
    routes = groupRoutes(suggestions);
  }

  suggestions.sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    return a.description.localeCompare(b.description, "ar");
  });
  for (const route of routes) {
    route.items.sort((a, b) => b.quantity - a.quantity || a.description.localeCompare(b.description, "ar"));
  }

  const uniqueProducts = new Set(suggestions.map(s => s.productId));
  const totalQuantity = suggestions.reduce((acc, s) => acc + s.quantity, 0);
  skippedRoutes.sort((a, b) => b.totalQuantity - a.totalQuantity);

  return {
    suggestions,
    routes,
    totalSuggestions: suggestions.length,
    totalQuantity,
    uniqueProductCount: uniqueProducts.size,
    routeCount: routes.length,
    skippedRoutes,
  };
}
