import type { ItemPerformanceRow } from "../../shared/api/reports";

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportItemPerformanceCsv(rows: ItemPerformanceRow[], from: string, to: string) {
  const headers = [
    "معرف الصنف",
    "الكود",
    "النوع",
    "القسم",
    "التصنيف",
    "الوصف",
    "الفرع",
    "المخزن",
    "افتتاح",
    "وارد مشتريات",
    "تحويل وارد",
    "مباع",
    "مرتجع بيع",
    "صافي المباع",
    "تحويل صادر",
    "حركات أخرى",
    "المتبقي",
    "نسبة التصريف %",
    "أيام التوفر",
    "معدل البيع/يوم",
    "أيام التغطية",
  ];

  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map(r =>
      [
        r.productId,
        r.code,
        r.itemType,
        r.section,
        r.classification,
        r.description,
        r.branchName,
        r.storeName,
        r.opening,
        r.inbound,
        r.transferIn,
        r.sold,
        r.returnSold,
        r.netSold,
        r.transferOut,
        r.otherMovements,
        r.closing,
        r.sellThroughPct ?? "",
        r.availableDays,
        r.ratePerDay ?? "",
        r.coverDays ?? "",
      ]
        .map(escapeCsvCell)
        .join(","),
    ),
  ];

  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `item-performance-${from}-to-${to}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
