import type { TransferSuggestion } from "./model";

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportTransfersCsv(suggestions: TransferSuggestion[], from: string, to: string, label = "transfers") {
  const headers = [
    "من فرع",
    "إلى فرع",
    "معرف الصنف",
    "الكود",
    "الوصف",
    "النوع",
    "القسم",
    "التصنيف",
    "الكمية المقترحة للتحويل",
    "سبب الفائض",
    "رصيد المُرسِل",
    "مبيعات المُرسِل",
    "تغطية المُرسِل (أيام)",
    "رصيد المُستقبِل",
    "مبيعات المُستقبِل",
    "معدل بيع المُستقبِل/يوم",
    "تغطية المُستقبِل (أيام)",
  ];

  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...suggestions.map(s =>
      [
        s.fromBranchName,
        s.toBranchName,
        s.productId,
        s.code,
        s.description,
        s.itemType,
        s.section,
        s.classification,
        s.quantity,
        s.fromReason,
        s.fromClosing,
        s.fromNetSold,
        s.fromCoverDays ?? "",
        s.toClosing,
        s.toNetSold,
        s.toRatePerDay,
        s.toCoverDays ?? "",
      ]
        .map(escapeCsvCell)
        .join(","),
    ),
  ];

  const bom = "\uFEFF";
  const blob = new Blob([bom + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${label}_${from}_${to}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
