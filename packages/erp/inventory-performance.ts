import { readFile } from "node:fs/promises";
import sql from "mssql";
import type { SqlConfig } from "./source.js";

export type MovementSource =
  | "gard"
  | "ward"
  | "sadr"
  | "return_s"
  | "return_w"
  | "sarf_s"
  | "sarf_w"
  | "trans"
  | "transstorbranch"
  | "manf"
  | "costitemsmanf";

export type MovementRole = Exclude<MovementSource, "trans" | "transstorbranch"> | "transfer_in" | "transfer_out";

export type RawMovementRow = {
  source: string;
  idprogramitems: string | number;
  idbranch: string | number;
  idstor: string | number;
  idno_s: string | number;
  line_id: string | number;
  iddet: string | number;
  idunit: string | number;
  quantity: number | string | null;
  bonus: number | string | null;
  movement_date: string;
  manufacturing_closed_date: string | null;
  destination_branch: string | number | null;
  destination_store: string | number | null;
  destination_product: string | number | null;
  changes_product: boolean | null;
  component_direction: number | null;
  consignment_flag: boolean | null;
};

export type RawProductLabel = {
  iddet: string | number;
  code: string | null;
  section: string | null;
  classification: string | null;
  size: string | null;
  item_type: string | null;
  service_item: boolean | null;
};

export type RawBranchLabel = {
  idbranch: string | number;
  branch_name: string | null;
};

export type RawStoreLabel = {
  idbranch: string | number;
  idstor: string | number;
  store_name: string | null;
};

export type RawCoverageRow = {
  source: string;
  all_lines: string | number;
  export_until: string;
  missing_headers: number;
  active_lines: number;
  null_deletion_flags: number;
};

export type RawOmittedRow = {
  source: string;
  all_lines: string | number;
};

export type InventorySnapshot = {
  source?: string;
  checkedAt?: string;
  recordsets: [
    RawCoverageRow[],
    RawMovementRow[],
    RawProductLabel[],
    RawBranchLabel[],
    RawStoreLabel[],
    RawOmittedRow[],
  ];
};

export type ItemPerformanceQuery = {
  baseline?: string;
  from: string;
  to: string;
  productIds?: string[] | null;
  branchIds?: string[] | null;
  storeKeys?: string[] | null;
};

export type ItemPerformanceRow = {
  programId: string;
  branchId: string;
  branchName: string;
  storeId: string;
  storeName: string;
  productId: string;
  code: string;
  itemType: string;
  section: string;
  classification: string;
  description: string;
  serviceItem: boolean;
  opening: number;
  rawOpening: number;
  inbound: number;
  transferIn: number;
  sold: number;
  returnSold: number;
  netSold: number;
  transferOut: number;
  otherMovements: number;
  closing: number;
  rawClosing: number;
  sellThroughPct: number | null;
  availableDays: number;
  periodDays: number;
  ratePerDay: number | null;
  coverDays: number | null;
  needsReview: boolean;
};

export type ItemPerformanceSummary = {
  rowCount: number;
  uniqueProductCount: number;
  zeroSalesCount: number;
  outOfStockCount: number;
  negativeClosingCount: number;
  totalOpening: number;
  totalInbound: number;
  totalTransferIn: number;
  totalSold: number;
  totalReturnSold: number;
  totalNetSold: number;
  totalTransferOut: number;
  totalOtherMovements: number;
  totalClosing: number;
};

export type ItemPerformanceReport = {
  meta: {
    baseline: string;
    from: string;
    to: string;
    periodDays: number;
    source: string;
    readAt: string;
  };
  summary: ItemPerformanceSummary;
  rows: ItemPerformanceRow[];
};

export type ItemLedgerQuery = {
  baseline?: string;
  from: string;
  to: string;
  branchId: string;
  storeId: string;
  productId: string;
};

export type ItemLedgerEntry = {
  date: string;
  role: MovementRole;
  label: string;
  documentId: string;
  lineId: string;
  inbound: number;
  outbound: number;
  delta: number;
  balanceAfter: number;
};

export type ItemLedgerReport = {
  meta: {
    baseline: string;
    from: string;
    to: string;
    source: string;
    readAt: string;
  };
  item: {
    programId: string;
    branchId: string;
    branchName: string;
    storeId: string;
    storeName: string;
    productId: string;
    code: string;
    itemType: string;
    section: string;
    classification: string;
    description: string;
  };
  opening: number;
  rawOpening: number;
  closing: number;
  rawClosing: number;
  totalInbound: number;
  totalOutbound: number;
  entries: ItemLedgerEntry[];
};

const ROLE_LABELS: Record<MovementRole, string> = {
  gard: "جرد أول المدة",
  ward: "وارد مشتريات",
  sadr: "بيع",
  return_s: "مرتجع بيع",
  return_w: "مرتجع مشتريات",
  sarf_s: "إذن صرف",
  sarf_w: "إذن إضافة",
  manf: "إنتاج تام",
  costitemsmanf: "خامات تصنيع",
  transfer_in: "تحويل وارد",
  transfer_out: "تحويل صادر",
};

const SIGNS: Record<Exclude<MovementSource, "trans" | "transstorbranch">, number> = {
  gard: 1,
  ward: 1,
  sadr: -1,
  return_s: 1,
  return_w: -1,
  sarf_s: -1,
  sarf_w: 1,
  manf: 1,
  costitemsmanf: -1,
};

const VALID_SOURCES = new Set<string>([...Object.keys(SIGNS), "trans", "transstorbranch"]);
const SCALE = 10_000;

function toScaled(value: number | string | null | undefined, fieldName: string): number {
  if (value === null || value === undefined || value === "") {
    throw new Error(`NULL ${fieldName}; cannot assume zero`);
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Non-finite ${fieldName}`);
  }
  return Math.round(num * SCALE);
}

function fromScaled(scaled: number): number {
  return Math.round(scaled) / SCALE;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Parse a YYYY-MM-DD date string into UTC-epoch milliseconds representing
 * that wall-clock midnight, avoiding local timezone DST shifts.
 */
function parseIsoDateMidnightMs(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date format: ${dateStr}. Expected YYYY-MM-DD`);
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date: ${dateStr}`);
  }
  return ms;
}

function addDaysMs(ms: number, days: number): number {
  return ms + days * 86_400_000;
}

function formatDateYmd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse ERP wall-clock timestamp ("YYYY-MM-DD HH:mm:ss[.SSS]" or ISO without TZ)
 * into wall-clock epoch milliseconds.
 */
function parseWallClockTimestampMs(value: string): { ms: number; dayMs: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid ERP wall-clock timestamp: ${value}`);
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const hh = Number(match[4] ?? 0);
  const mm = Number(match[5] ?? 0);
  const ss = Number(match[6] ?? 0);
  const frac = Number((match[7] ?? "0").slice(0, 3).padEnd(3, "0"));
  const dayMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const ms = Date.UTC(y, m - 1, d, hh, mm, ss, frac);
  return { ms, dayMs };
}

type LedgerEvent = {
  tsMs: number;
  dayMs: number;
  displayDate: string;
  role: MovementRole;
  documentId: string;
  lineId: string;
  deltaScaled: number;
};

type GroupedLedger = {
  programId: string;
  branchId: string;
  storeId: string;
  productId: string;
  ledger: LedgerEvent[];
};

function formatWallClockDisplay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function buildGroupedLedgers(
  snapshot: InventorySnapshot,
  query: ItemPerformanceQuery,
) {
  const baseline = query.baseline ?? "2026-08-01";
  const baselineMs = parseIsoDateMidnightMs(baseline);
  const startMs = parseIsoDateMidnightMs(query.from);
  const toMs = parseIsoDateMidnightMs(query.to);
  const untilMs = addDaysMs(toMs, 1);

  if (!(baselineMs < startMs && startMs < untilMs)) {
    throw new Error("Require baseline < from <= to");
  }

  const [coverage, rows, products, branches, stores, omitted] = snapshot.recordsets;

  if (coverage.length !== VALID_SOURCES.size || !coverage.every(r => VALID_SOURCES.has(r.source))) {
    throw new Error("Missing or incomplete source coverage");
  }
  if (coverage.some(r => r.missing_headers > 0 || r.null_deletion_flags > 0)) {
    throw new Error("Unresolved headers or deletion flags in source");
  }
  if (coverage.some(r => parseWallClockTimestampMs(r.export_until).ms < untilMs)) {
    throw new Error("Requested end date exceeds the SQL export cutoff");
  }
  if (omitted.some(r => Number(r.all_lines) > 0)) {
    throw new Error("Additional inventory sources contain data and require investigation");
  }

  const productMap = new Map<string, RawProductLabel>();
  for (const p of products) {
    productMap.set(String(p.iddet), p);
  }
  const branchMap = new Map<string, string>();
  for (const b of branches) {
    branchMap.set(String(b.idbranch), String(b.branch_name ?? b.idbranch).trim());
  }
  const storeMap = new Map<string, string>();
  for (const s of stores) {
    const key = `${s.idbranch}:${s.idstor}`;
    storeMap.set(key, String(s.store_name ?? s.idstor).trim());
  }

  const filterProducts = query.productIds ? new Set(query.productIds.map(String)) : null;
  const filterBranches = query.branchIds ? new Set(query.branchIds.map(String)) : null;
  const filterStores = query.storeKeys ? new Set(query.storeKeys.map(String)) : null;

  const eventsByKey = new Map<string, GroupedLedger>();
  const seen = new Set<string>();
  let openingRows = 0;

  for (const row of rows) {
    const source = row.source;
    if (!VALID_SOURCES.has(source) || String(row.idunit) !== "1") {
      throw new Error(`Unknown source (${source}) or unsupported unit (${row.idunit})`);
    }
    const identity = `${source}|${row.idprogramitems}|${row.idbranch}|${row.line_id}`;
    if (seen.has(identity)) {
      throw new Error(`Duplicate source row: ${identity}`);
    }
    seen.add(identity);

    if (source === "trans" && row.changes_product !== false) {
      throw new Error("Unsupported product-changing internal transfer");
    }
    if (source === "costitemsmanf" && row.component_direction !== -1) {
      throw new Error("Unverified manufacturing component direction");
    }
    if ((source === "sarf_s" || source === "sarf_w") && row.consignment_flag === true) {
      throw new Error("Consignment movements require separate validation");
    }

    let ts = parseWallClockTimestampMs(row.movement_date);
    if (source === "gard") {
      openingRows += 1;
      if (ts.ms !== baselineMs) {
        throw new Error("Opening rows do not match assumed baseline date");
      }
    }
    if (source === "manf") {
      if (!row.manufacturing_closed_date) {
        throw new Error("Open manufacturing order needs separate validation");
      }
      ts = parseWallClockTimestampMs(row.manufacturing_closed_date);
    }

    if (ts.ms < baselineMs || ts.ms >= untilMs) {
      continue;
    }

    const quantityScaled = toScaled(row.quantity, "quantity");
    const bonusScaled = toScaled(row.bonus, "bonus");
    if (bonusScaled !== 0) {
      throw new Error("Nonzero bonus is not yet supported");
    }

    const productId = String(row.iddet);
    if (!productMap.has(productId)) {
      throw new Error(`Unresolved product ${productId}`);
    }

    const emit = (branchId: string, storeId: string, role: MovementRole, sign: number) => {
      const storeKey = `${branchId}:${storeId}`;
      if (!storeMap.has(storeKey)) {
        throw new Error(`Unresolved store ${storeKey}`);
      }
      if (filterProducts && !filterProducts.has(productId)) return;
      if (filterBranches && !filterBranches.has(branchId)) return;
      if (filterStores && !filterStores.has(storeKey)) return;

      const programId = String(row.idprogramitems);
      const groupKey = `${programId}|${branchId}|${storeId}|${productId}`;
      let group = eventsByKey.get(groupKey);
      if (!group) {
        group = { programId, branchId, storeId, productId, ledger: [] };
        eventsByKey.set(groupKey, group);
      }
      group.ledger.push({
        tsMs: ts.ms,
        dayMs: ts.dayMs,
        displayDate: formatWallClockDisplay(ts.ms),
        role,
        documentId: String(row.idno_s),
        lineId: String(row.line_id),
        deltaScaled: sign * quantityScaled,
      });
    };

    if (source === "trans" || source === "transstorbranch") {
      if (source === "trans" && row.destination_product !== null && String(row.destination_product) !== productId) {
        throw new Error("Different destination product in transfer");
      }
      if (row.destination_branch === null || row.destination_store === null) {
        throw new Error("Transfer missing destination branch or store");
      }
      emit(String(row.idbranch), String(row.idstor), "transfer_out", -1);
      emit(String(row.destination_branch), String(row.destination_store), "transfer_in", 1);
    } else {
      const sign = SIGNS[source as Exclude<MovementSource, "trans" | "transstorbranch">];
      emit(String(row.idbranch), String(row.idstor), source as MovementRole, sign);
    }
  }

  if (openingRows === 0) {
    throw new Error("No opening evidence found in snapshot");
  }

  return {
    baselineMs,
    startMs,
    toMs,
    untilMs,
    productMap,
    branchMap,
    storeMap,
    eventsByKey,
  };
}

/**
 * Compute item performance report from an ERP inventory snapshot.
 */
export function computeItemPerformance(
  snapshot: InventorySnapshot,
  query: ItemPerformanceQuery,
): ItemPerformanceReport {
  const {
    baselineMs,
    startMs,
    toMs,
    untilMs,
    productMap,
    branchMap,
    storeMap,
    eventsByKey,
  } = buildGroupedLedgers(snapshot, query);

  const periodDays = Math.round((untilMs - startMs) / 86_400_000);
  const resultRows: ItemPerformanceRow[] = [];
  const uniqueProducts = new Set<string>();

  let totalOpening = 0;
  let totalInbound = 0;
  let totalTransferIn = 0;
  let totalSold = 0;
  let totalReturnSold = 0;
  let totalNetSold = 0;
  let totalTransferOut = 0;
  let totalOtherMovements = 0;
  let totalClosing = 0;
  let zeroSalesCount = 0;
  let outOfStockCount = 0;
  let negativeClosingCount = 0;

  const sortedGroups = [...eventsByKey.values()].sort((a, b) =>
    a.branchId.localeCompare(b.branchId) ||
    a.storeId.localeCompare(b.storeId) ||
    a.productId.localeCompare(b.productId),
  );

  for (const group of sortedGroups) {
    group.ledger.sort((a, b) => a.tsMs - b.tsMs);

    let rawOpeningScaled = 0;
    let balanceScaled = 0;
    const movementsScaled: Record<MovementRole, number> = {
      gard: 0,
      ward: 0,
      sadr: 0,
      return_s: 0,
      return_w: 0,
      sarf_s: 0,
      sarf_w: 0,
      manf: 0,
      costitemsmanf: 0,
      transfer_in: 0,
      transfer_out: 0,
    };
    const dailyEvents = new Map<number, LedgerEvent[]>();
    let hasPositiveSadr = false;

    for (const ev of group.ledger) {
      balanceScaled += ev.deltaScaled;
      if (ev.role === "sadr" && ev.deltaScaled > 0) {
        hasPositiveSadr = true;
      }
      if (ev.tsMs < startMs) {
        rawOpeningScaled += ev.deltaScaled;
      } else {
        movementsScaled[ev.role] += ev.deltaScaled;
        const list = dailyEvents.get(ev.dayMs) ?? [];
        list.push(ev);
        dailyEvents.set(ev.dayMs, list);
      }
    }

    // Daily availability loop
    let dailyBalanceScaled = rawOpeningScaled;
    let availableDays = 0;
    for (let dayMs = startMs; dayMs < untilMs; dayMs = addDaysMs(dayMs, 1)) {
      let available = dailyBalanceScaled > 0;
      const dayList = dailyEvents.get(dayMs);
      if (dayList) {
        const byTimestamp = new Map<number, number>();
        for (const ev of dayList) {
          byTimestamp.set(ev.tsMs, (byTimestamp.get(ev.tsMs) ?? 0) + ev.deltaScaled);
        }
        const sortedTimes = [...byTimestamp.keys()].sort((a, b) => a - b);
        for (const t of sortedTimes) {
          dailyBalanceScaled += byTimestamp.get(t)!;
          if (dailyBalanceScaled > 0) available = true;
        }
      }
      if (available) availableDays += 1;
    }

    const reportedOpeningScaled = Math.max(rawOpeningScaled, 0);
    const reportedClosingScaled = Math.max(balanceScaled, 0);

    const opening = fromScaled(reportedOpeningScaled);
    const rawOpening = fromScaled(rawOpeningScaled);
    const closing = fromScaled(reportedClosingScaled);
    const rawClosing = fromScaled(balanceScaled);

    const inbound = fromScaled(movementsScaled.ward);
    const transferIn = fromScaled(movementsScaled.transfer_in);
    const sold = fromScaled(-movementsScaled.sadr);
    const returnSold = fromScaled(movementsScaled.return_s);
    const netSold = fromScaled(-movementsScaled.sadr - movementsScaled.return_s);
    const transferOut = fromScaled(-movementsScaled.transfer_out);
    const otherMovementsScaled =
      movementsScaled.sarf_w +
      movementsScaled.sarf_s +
      movementsScaled.return_w +
      movementsScaled.manf +
      movementsScaled.costitemsmanf +
      movementsScaled.gard;
    const otherMovements = fromScaled(otherMovementsScaled);

    // Skip rows that have zero opening, zero closing, and zero movement in the period
    const hasActivityInPeriod =
      inbound !== 0 ||
      transferIn !== 0 ||
      sold !== 0 ||
      returnSold !== 0 ||
      transferOut !== 0 ||
      otherMovements !== 0;
    if (opening === 0 && closing === 0 && !hasActivityInPeriod) {
      continue;
    }

    const otherInbound = fromScaled(Math.max(0, movementsScaled.sarf_w) + Math.max(0, movementsScaled.manf));
    const denominator = opening + inbound + transferIn + otherInbound;
    const sellThroughPct = denominator > 0 ? roundTo((netSold * 100) / denominator, 2) : null;
    const ratePerDay = availableDays > 0 && netSold >= 0 ? roundTo(netSold / availableDays, 4) : null;
    const coverDays = ratePerDay && ratePerDay > 0 ? roundTo(closing / ratePerDay, 1) : null;

    const prod = productMap.get(group.productId)!;
    const contextual =
      transferOut !== 0 ||
      movementsScaled.sarf_s !== 0 ||
      movementsScaled.sarf_w !== 0 ||
      movementsScaled.return_w !== 0 ||
      movementsScaled.manf !== 0 ||
      movementsScaled.costitemsmanf !== 0 ||
      movementsScaled.gard !== 0;

    const needsReview = contextual || hasPositiveSadr || Boolean(prod.service_item);

    resultRows.push({
      programId: group.programId,
      branchId: group.branchId,
      branchName: branchMap.get(group.branchId) ?? group.branchId,
      storeId: group.storeId,
      storeName: storeMap.get(`${group.branchId}:${group.storeId}`) ?? group.storeId,
      productId: group.productId,
      code: String(prod.code ?? "").trim(),
      itemType: String(prod.item_type ?? "").trim(),
      section: String(prod.section ?? "").trim(),
      classification: String(prod.classification ?? "").trim(),
      description: String(prod.size ?? "").trim(),
      serviceItem: Boolean(prod.service_item),
      opening,
      rawOpening,
      inbound,
      transferIn,
      sold,
      returnSold,
      netSold,
      transferOut,
      otherMovements,
      closing,
      rawClosing,
      sellThroughPct,
      availableDays,
      periodDays,
      ratePerDay,
      coverDays,
      needsReview,
    });

    uniqueProducts.add(group.productId);
    totalOpening = roundTo(totalOpening + opening, 4);
    totalInbound = roundTo(totalInbound + inbound, 4);
    totalTransferIn = roundTo(totalTransferIn + transferIn, 4);
    totalSold = roundTo(totalSold + sold, 4);
    totalReturnSold = roundTo(totalReturnSold + returnSold, 4);
    totalNetSold = roundTo(totalNetSold + netSold, 4);
    totalTransferOut = roundTo(totalTransferOut + transferOut, 4);
    totalOtherMovements = roundTo(totalOtherMovements + otherMovements, 4);
    totalClosing = roundTo(totalClosing + closing, 4);
    if (netSold <= 0) zeroSalesCount += 1;
    if (closing <= 0) outOfStockCount += 1;
    if (rawClosing < 0) negativeClosingCount += 1;
  }

  return {
    meta: {
      baseline: formatDateYmd(baselineMs),
      from: formatDateYmd(startMs),
      to: formatDateYmd(toMs),
      periodDays,
      source: snapshot.source ?? "ERP snapshot",
      readAt: snapshot.checkedAt ?? new Date().toISOString(),
    },
    summary: {
      rowCount: resultRows.length,
      uniqueProductCount: uniqueProducts.size,
      zeroSalesCount,
      outOfStockCount,
      negativeClosingCount,
      totalOpening,
      totalInbound,
      totalTransferIn,
      totalSold,
      totalReturnSold,
      totalNetSold,
      totalTransferOut,
      totalOtherMovements,
      totalClosing,
    },
    rows: resultRows,
  };
}

/**
 * Compute chronological item movement ledger (كارت الصنف) for a specific
 * product, branch, and store within the requested period.
 */
export function computeItemLedger(
  snapshot: InventorySnapshot,
  query: ItemLedgerQuery,
): ItemLedgerReport {
  const {
    baselineMs,
    startMs,
    toMs,
    productMap,
    branchMap,
    storeMap,
    eventsByKey,
  } = buildGroupedLedgers(snapshot, {
    baseline: query.baseline,
    from: query.from,
    to: query.to,
    productIds: [query.productId],
    branchIds: [query.branchId],
    storeKeys: [`${query.branchId}:${query.storeId}`],
  });

  const prod = productMap.get(query.productId);
  if (!prod) {
    throw new Error(`Product ${query.productId} not found`);
  }

  const group = [...eventsByKey.values()][0];
  let rawOpeningScaled = 0;
  let balanceScaled = 0;
  let totalInboundScaled = 0;
  let totalOutboundScaled = 0;
  const entries: ItemLedgerEntry[] = [];

  if (group) {
    group.ledger.sort((a, b) => a.tsMs - b.tsMs);
    for (const ev of group.ledger) {
      balanceScaled += ev.deltaScaled;
      if (ev.tsMs < startMs) {
        rawOpeningScaled += ev.deltaScaled;
      } else {
        const delta = fromScaled(ev.deltaScaled);
        const inbound = ev.deltaScaled > 0 ? delta : 0;
        const outbound = ev.deltaScaled < 0 ? fromScaled(-ev.deltaScaled) : 0;
        if (ev.deltaScaled > 0) totalInboundScaled += ev.deltaScaled;
        else totalOutboundScaled += -ev.deltaScaled;

        entries.push({
          date: ev.displayDate,
          role: ev.role,
          label: ROLE_LABELS[ev.role],
          documentId: ev.documentId,
          lineId: ev.lineId,
          inbound,
          outbound,
          delta,
          balanceAfter: fromScaled(balanceScaled),
        });
      }
    }
  }

  const rawOpening = fromScaled(rawOpeningScaled);
  const rawClosing = fromScaled(balanceScaled);

  return {
    meta: {
      baseline: formatDateYmd(baselineMs),
      from: formatDateYmd(startMs),
      to: formatDateYmd(toMs),
      source: snapshot.source ?? "ERP snapshot",
      readAt: snapshot.checkedAt ?? new Date().toISOString(),
    },
    item: {
      programId: group?.programId ?? "9",
      branchId: query.branchId,
      branchName: branchMap.get(query.branchId) ?? query.branchId,
      storeId: query.storeId,
      storeName: storeMap.get(`${query.branchId}:${query.storeId}`) ?? query.storeId,
      productId: query.productId,
      code: String(prod.code ?? "").trim(),
      itemType: String(prod.item_type ?? "").trim(),
      section: String(prod.section ?? "").trim(),
      classification: String(prod.classification ?? "").trim(),
      description: String(prod.size ?? "").trim(),
    },
    opening: Math.max(rawOpening, 0),
    rawOpening,
    closing: Math.max(rawClosing, 0),
    rawClosing,
    totalInbound: fromScaled(totalInboundScaled),
    totalOutbound: fromScaled(totalOutboundScaled),
    entries,
  };
}

export async function loadInventorySnapshotFromFile(filePath: string): Promise<InventorySnapshot> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as InventorySnapshot;
}

/**
 * Load inventory snapshot directly from ERP SQL Server (read-only) using the
 * same query structure as scripts/inspect_inventory_reports.sql.
 */
export async function loadInventorySnapshotFromSql(
  config: SqlConfig,
  untilDateExclusive: string,
  inspectSqlText: string,
): Promise<InventorySnapshot> {
  const pool = new sql.ConnectionPool({
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeout: 8000,
    requestTimeout: 60000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      instanceName: config.instance || undefined,
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate ?? true,
      appName: "Reports Read Only",
    },
  });

  try {
    await pool.connect();
    // Replace the hardcoded header variables with parameterized values safely
    const yyyymmdd = untilDateExclusive.replace(/-/g, "");
    if (!/^\d{8}$/.test(yyyymmdd)) throw new Error("Invalid until date");
    const batch = inspectSqlText.replace(
      /DECLARE\s+@program\s+bigint=\d+,\s*@until\s+datetime='\d{8}';/i,
      `DECLARE @program bigint=${config.programId}, @until datetime='${yyyymmdd}';`,
    );
    const result = await pool.request().query(batch);
    const recordsets = result.recordsets as unknown as InventorySnapshot["recordsets"];
    if (!Array.isArray(recordsets) || recordsets.length < 6) {
      throw new Error("Unexpected SQL recordsets returned for inventory report");
    }
    return {
      source: `ERP SQL (${config.database})`,
      checkedAt: new Date().toISOString(),
      recordsets,
    };
  } finally {
    await pool.close();
  }
}
