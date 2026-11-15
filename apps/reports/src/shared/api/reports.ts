import type { CatalogNode, LocationOption } from "../../components/catalog-filter/model";

export type CatalogResponse = {
  nodes: CatalogNode[];
  locations: LocationOption[];
  source: { label: string; readAt: string };
};

export type ItemPerformanceRequest = {
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
  price?: number | null;
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
  hasExtraMovements: boolean;
  inboundByDaysAgo?: Array<{ daysAgo: number; qty: number }>;
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

export type ItemLedgerRequest = {
  baseline?: string;
  from: string;
  to: string;
  branchId: string;
  storeId: string;
  productId: string;
};

export type ItemLedgerEntry = {
  date: string;
  role: string;
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

export class UnauthorizedError extends Error {
  constructor(message = "سجّل الدخول أولًا") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export type SessionState = {
  authenticated: boolean;
  username?: string | null;
  displayName?: string | null;
};

export async function fetchSession(signal?: AbortSignal): Promise<SessionState> {
  const response = await fetch("/api/reports/session", {
    signal,
    cache: "no-store",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error("تعذر التحقق من الجلسة.");
  }
  return (await response.json()) as SessionState;
}

export async function loginReports(username: string, password: string): Promise<void> {
  const response = await fetch("/api/reports/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-emoji-request": "1",
    },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    let message = "تعذر تسجيل الدخول.";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Ignore JSON parse failure
    }
    throw new Error(message);
  }
}

export async function logoutReports(): Promise<void> {
  await fetch("/api/reports/logout", {
    method: "POST",
    headers: {
      "x-emoji-request": "1",
    },
    credentials: "include",
    cache: "no-store",
  });
}

export async function fetchFilterOptions(signal?: AbortSignal): Promise<CatalogResponse> {
  const response = await fetch("/api/reports/filter-options", {
    signal,
    cache: "no-store",
    credentials: "include",
  });
  if (response.status === 401 || response.status === 403) {
    throw new UnauthorizedError("انتهت الجلسة أو ليست لديك صلاحية الوصول للتقارير.");
  }
  if (!response.ok) {
    throw new Error("تعذر تحميل بيانات ERP. أعد المحاولة.");
  }
  return (await response.json()) as CatalogResponse;
}

async function postReportApi<T>(url: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-emoji-request": "1",
    },
    credentials: "include",
    body: JSON.stringify(payload),
    signal,
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403) {
    throw new UnauthorizedError("انتهت الجلسة أو ليست لديك صلاحية الوصول للتقارير.");
  }
  if (!response.ok) {
    let message = "تعذر تشغيل التقرير. أعد المحاولة.";
    try {
      const err = (await response.json()) as { error?: string };
      if (err.error) {
        if (err.error.includes("exceeds the SQL export cutoff")) {
          message = "تاريخ النهاية المطلوب أحدث من آخر تحديث متاح في نسخة البيانات.";
        } else if (err.error.includes("Require baseline")) {
          message = "الفترة المطلوبة يجب أن تبدأ بعد تاريخ الافتتاح الأساسي (2026-08-01).";
        } else if (err.error.includes("not configured") || err.error.includes("unavailable")) {
          message = "مصدر بيانات المخزون غير متاح حالياً.";
        } else {
          message = err.error;
        }
      }
    } catch {
      // Ignore JSON parse failure
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function fetchItemPerformance(
  payload: ItemPerformanceRequest,
  signal?: AbortSignal,
): Promise<ItemPerformanceReport> {
  return postReportApi<ItemPerformanceReport>("/api/reports/item-performance", payload, signal);
}

export function fetchItemLedger(
  payload: ItemLedgerRequest,
  signal?: AbortSignal,
): Promise<ItemLedgerReport> {
  return postReportApi<ItemLedgerReport>("/api/reports/item-ledger", payload, signal);
}

export type ProductCardResponse = {
  productId: string;
  images: Array<{ id: string; url: string }>;
  erp: {
    unit: string;
    price: number | null;
    kind?: string;
    name: string;
    category: string;
    description: string;
  } | null;
};

export async function fetchProductCard(
  productId: string,
  code?: string,
  signal?: AbortSignal,
): Promise<ProductCardResponse> {
  const qs = code ? `?code=${encodeURIComponent(code)}` : "";
  const response = await fetch(`/api/reports/products/${encodeURIComponent(productId)}${qs}`, {
    signal,
    cache: "no-store",
    credentials: "include",
  });
  if (response.status === 401 || response.status === 403) {
    throw new UnauthorizedError("انتهت الجلسة أو ليست لديك صلاحية الوصول للتقارير.");
  }
  if (!response.ok) {
    throw new Error("تعذر تحميل بطاقة الصنف.");
  }
  return (await response.json()) as ProductCardResponse;
}
