import type { GroupByLevel } from "../../components/catalog-filter/model";
import type { ItemPerformanceRow } from "../../shared/api/reports";

export type { GroupByLevel };

export const GROUP_BY_LABELS: Record<GroupByLevel, string> = {
  type: "النوع",
  section: "القسم",
  classification: "التصنيف",
  size: "المقاس / الوصف",
  model: "كود الموديل",
};

export type DisplayPerformanceRow = ItemPerformanceRow & {
  groupCount?: number;
  groupTitle?: string;
  groupSubtitle?: string;
  groupPath?: string;
  memberRows?: ItemPerformanceRow[];
};

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function resolveGroupMeta(row: ItemPerformanceRow, level: GroupByLevel) {
  const itemType = row.itemType.trim();
  const section = row.section.trim();
  const classification = row.classification.trim();
  const description = row.description.trim();
  const modelCode = row.code && row.code !== "*" ? row.code.trim() : `#${row.productId}`;

  switch (level) {
    case "type":
      return {
        key: itemType || "غير مصنف",
        title: itemType || "غير مصنف",
        path: "تجميع حسب النوع",
        subtitleExtra: "",
      };
    case "section":
      return {
        key: `${itemType}|${section}`,
        title: section || "غير مصنف",
        path: itemType || "تجميع حسب القسم",
        subtitleExtra: "",
      };
    case "classification":
      return {
        key: `${itemType}|${section}|${classification}`,
        title: classification || "غير مصنف",
        path: [itemType, section].filter(Boolean).join(" / ") || "تجميع حسب التصنيف",
        subtitleExtra: "",
      };
    case "size":
      return {
        key: `${itemType}|${section}|${classification}|${description}`,
        title: description || "بدون وصف",
        path: [itemType, section, classification].filter(Boolean).join(" / ") || "تجميع حسب المقاس / الوصف",
        subtitleExtra: "",
      };
    case "model":
      return {
        key: `${itemType}|${section}|${classification}|${description}|${modelCode}`,
        title: modelCode,
        path: [itemType, section, classification].filter(Boolean).join(" / "),
        subtitleExtra: description,
      };
  }
}

export function groupItemPerformanceRows(
  rows: ItemPerformanceRow[],
  groupBy: GroupByLevel | null,
  groupByBranch = false,
): DisplayPerformanceRow[] {
  if (!groupBy && !groupByBranch) return rows;

  const groups = new Map<
    string,
    {
      sample: ItemPerformanceRow;
      meta: ReturnType<typeof resolveGroupMeta> | null;
      members: ItemPerformanceRow[];
      products: Set<string>;
      branches: Set<string>;
      stores: Set<string>;
      prices: Set<number>;
      opening: number;
      rawOpening: number;
      inbound: number;
      transferIn: number;
      sold: number;
      returnSold: number;
      netSold: number;
      transferOut: number;
      otherMovements: number;
      otherInbound: number;
      closing: number;
      rawClosing: number;
      availableDays: number;
      periodDays: number;
      hasExtraMovements: boolean;
    }
  >();

  for (const r of rows) {
    const meta = groupBy ? resolveGroupMeta(r, groupBy) : null;
    const itemKey = meta ? meta.key : r.productId;
    const branchKey = groupByBranch ? "all" : r.branchId;
    const mapKey = `${itemKey}||${branchKey}`;
    let entry = groups.get(mapKey);
    if (!entry) {
      entry = {
        sample: r,
        meta,
        members: [],
        products: new Set<string>(),
        branches: new Set<string>(),
        stores: new Set<string>(),
        prices: new Set<number>(),
        opening: 0,
        rawOpening: 0,
        inbound: 0,
        transferIn: 0,
        sold: 0,
        returnSold: 0,
        netSold: 0,
        transferOut: 0,
        otherMovements: 0,
        otherInbound: 0,
        closing: 0,
        rawClosing: 0,
        availableDays: 0,
        periodDays: r.periodDays,
        hasExtraMovements: false,
      };
      groups.set(mapKey, entry);
    }

    entry.members.push(r);
    entry.products.add(r.productId);
    entry.branches.add(r.branchName || r.branchId);
    entry.stores.add(r.storeName || r.storeId);
    if (typeof r.price === "number" && r.price > 0) {
      entry.prices.add(r.price);
    }
    entry.opening += r.opening;
    entry.rawOpening += r.rawOpening;
    entry.inbound += r.inbound;
    entry.transferIn += r.transferIn;
    entry.sold += r.sold;
    entry.returnSold += r.returnSold;
    entry.netSold += r.netSold;
    entry.transferOut += r.transferOut;
    entry.otherMovements += r.otherMovements;
    if (r.otherMovements > 0) entry.otherInbound += r.otherMovements;
    entry.closing += r.closing;
    entry.rawClosing += r.rawClosing;
    entry.availableDays = Math.max(entry.availableDays, r.availableDays);
    entry.periodDays = Math.max(entry.periodDays, r.periodDays);
    entry.hasExtraMovements = entry.hasExtraMovements || r.hasExtraMovements;
  }

  return [...groups.entries()].map(([mapKey, g]) => {
    const opening = roundTo(g.opening, 2);
    const inbound = roundTo(g.inbound, 2);
    const transferIn = roundTo(g.transferIn, 2);
    const sold = roundTo(g.sold, 2);
    const returnSold = roundTo(g.returnSold, 2);
    const netSold = roundTo(g.netSold, 2);
    const transferOut = roundTo(g.transferOut, 2);
    const otherMovements = roundTo(g.otherMovements, 2);
    const closing = roundTo(g.closing, 2);

    const denominator = opening + inbound + transferIn + g.otherInbound;
    const sellThroughPct = denominator > 0 ? roundTo((netSold * 100) / denominator, 2) : null;
    const effectiveRateDays = Math.max(g.availableDays, Math.min(7, Math.max(1, g.periodDays || 7)));
    const ratePerDay = g.availableDays > 0 && netSold >= 0 ? roundTo(netSold / effectiveRateDays, 4) : null;
    const coverDays = ratePerDay && ratePerDay > 0 ? roundTo(closing / ratePerDay, 1) : null;

    const countLabel = `${g.products.size} صنف`;
    const sampleTitle = g.sample.code && g.sample.code !== "*" ? g.sample.code : `#${g.sample.productId}`;
    const groupTitle = g.meta ? g.meta.title : sampleTitle;
    const groupSubtitle = g.meta
      ? (g.meta.subtitleExtra ? `${g.meta.subtitleExtra} · ${countLabel}` : countLabel)
      : (g.sample.description || g.sample.classification || g.sample.section);
    const groupPath = g.meta
      ? g.meta.path
      : `${[g.sample.itemType, g.sample.section, g.sample.classification].filter(Boolean).join(" / ")} · #${g.sample.productId}`;

    const branchId = groupByBranch ? (g.branches.size === 1 ? g.sample.branchId : "all") : g.sample.branchId;
    const branchName = groupByBranch
      ? (g.branches.size === 1 ? [...g.branches][0] : `إجمالي الفروع (${g.branches.size})`)
      : (g.sample.branchName || g.sample.branchId);
    const storeName = g.stores.size === 1 ? [...g.stores][0] : `${g.stores.size} مخازن`;
    const scopeTag = groupBy ?? "branch";

    return {
      ...g.sample,
      branchId,
      branchName,
      storeId: g.stores.size === 1 ? g.sample.storeId : "all",
      storeName,
      productId: `group:${scopeTag}:${mapKey}`,
      code: groupTitle,
      section: groupBy === "type" ? "" : g.sample.section,
      classification: groupBy === "type" || groupBy === "section" ? "" : g.sample.classification,
      description: groupSubtitle,
      price: g.prices.size === 1 ? [...g.prices][0] : (g.members.every(m => m.price === undefined) ? undefined : null),
      opening,
      rawOpening: roundTo(g.rawOpening, 2),
      inbound,
      transferIn,
      sold,
      returnSold,
      netSold,
      transferOut,
      otherMovements,
      closing,
      rawClosing: roundTo(g.rawClosing, 2),
      sellThroughPct,
      availableDays: g.availableDays,
      periodDays: g.periodDays,
      ratePerDay,
      coverDays,
      hasExtraMovements: g.hasExtraMovements,
      groupCount: g.products.size,
      groupTitle,
      groupSubtitle,
      groupPath,
      memberRows: [...g.members].sort((a, b) => b.netSold - a.netSold || b.closing - a.closing),
    };
  });
}
