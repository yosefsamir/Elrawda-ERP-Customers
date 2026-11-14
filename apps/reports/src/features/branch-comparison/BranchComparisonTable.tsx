import { useMemo, useState } from "react";
import type { ItemPerformanceRow } from "../../shared/api/reports";
import { aggregateBranches, type BranchComparisonRow } from "./model";

type BranchSort = "netSold-desc" | "sellThrough-desc" | "closing-desc" | "zeroSales-desc";

const fmtNum = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function exportBranchComparisonCsv(rows: BranchComparisonRow[], from: string, to: string) {
  const headers = [
    "رقم الفرع",
    "الفرع",
    "عدد الأصناف",
    "أصناف بلا بيع",
    "افتتاح",
    "وارد",
    "تحويل وارد",
    "مباع",
    "مرتجع",
    "صافي البيع",
    "تحويل صادر",
    "المتبقي",
    "نسبة التصريف %",
  ];
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map(r =>
      [
        r.branchId,
        r.branchName,
        r.uniqueProductCount,
        r.zeroSalesCount,
        r.opening,
        r.inbound,
        r.transferIn,
        r.sold,
        r.returnSold,
        r.netSold,
        r.transferOut,
        r.closing,
        r.sellThroughPct ?? "",
      ]
        .map(escapeCsvCell)
        .join(","),
    ),
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `branch-comparison-${from}-to-${to}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

type Props = {
  rows: ItemPerformanceRow[];
  from: string;
  to: string;
  onSelectBranch: (branchId: string) => void;
};

export function BranchComparisonTable({ rows, from, to, onSelectBranch }: Props) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<BranchSort>("netSold-desc");

  const branches = useMemo(() => aggregateBranches(rows), [rows]);

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? branches.filter(b => b.branchName.toLowerCase().includes(q) || b.branchId.includes(q))
      : [...branches];

    list.sort((a, b) => {
      if (sortBy === "netSold-desc") return b.netSold - a.netSold || b.closing - a.closing;
      if (sortBy === "closing-desc") return b.closing - a.closing || b.netSold - a.netSold;
      if (sortBy === "zeroSales-desc") return b.zeroSalesCount - a.zeroSalesCount || b.closing - a.closing;
      const sa = a.sellThroughPct ?? -1;
      const sb = b.sellThroughPct ?? -1;
      return sb - sa || b.netSold - a.netSold;
    });
    return list;
  }, [branches, search, sortBy]);

  return (
    <section className="ip-results-section" aria-label="مقارنة الفروع">
      <div className="ip-toolbar">
        <div className="ip-count-bar" style={{ margin: 0 }}>
          <span>إجمالي {fmtNum.format(filteredAndSorted.length)} فرع · اضغط على أي فرع لعرض أصنافه</span>
        </div>

        <div className="ip-toolbar-actions">
          <div className="ip-search-box">
            <input
              type="search"
              placeholder="بحث باسم الفرع…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <select
            aria-label="ترتيب الفروع"
            className="ip-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value as BranchSort)}
          >
            <option value="netSold-desc">الأكثر مبيعاً</option>
            <option value="sellThrough-desc">أعلى نسبة تصريف</option>
            <option value="closing-desc">أعلى رصيد متبقي</option>
            <option value="zeroSales-desc">الأكثر أصنافاً بلا بيع</option>
          </select>

          <button
            type="button"
            className="ip-btn-outline"
            disabled={filteredAndSorted.length === 0}
            onClick={() => exportBranchComparisonCsv(filteredAndSorted, from, to)}
          >
            <span>تصدير CSV</span>
          </button>
        </div>
      </div>

      {filteredAndSorted.length === 0 ? (
        <div className="ip-empty">لا توجد فروع مطابقة للبحث.</div>
      ) : (
        <div className="ip-table-wrap" style={{ marginTop: 12 }}>
          <table className="ip-table">
            <thead>
              <tr>
                <th>الفرع</th>
                <th className="num">الأصناف</th>
                <th className="num">بلا بيع</th>
                <th className="num">افتتاح</th>
                <th className="num">وارد</th>
                <th className="num">تحويل وارد</th>
                <th className="num">مباع</th>
                <th className="num">مرتجع</th>
                <th className="num">صافي البيع</th>
                <th className="num">تحويل صادر</th>
                <th className="num">المتبقي</th>
                <th className="num">التصريف</th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSorted.map(b => (
                <tr
                  key={b.branchId}
                  className="is-clickable"
                  onClick={() => onSelectBranch(b.branchId)}
                >
                  <td>
                    <div className="ip-loc-cell">
                      <strong>{b.branchName}</strong>
                      <small>فرع #{b.branchId}</small>
                    </div>
                  </td>
                  <td className="num">{fmtNum.format(b.uniqueProductCount)}</td>
                  <td className="num">{fmtNum.format(b.zeroSalesCount)}</td>
                  <td className="num">{fmtNum.format(b.opening)}</td>
                  <td className="num">{fmtNum.format(b.inbound)}</td>
                  <td className="num">{fmtNum.format(b.transferIn)}</td>
                  <td className="num">{fmtNum.format(b.sold)}</td>
                  <td className="num">{fmtNum.format(b.returnSold)}</td>
                  <td className="num"><strong>{fmtNum.format(b.netSold)}</strong></td>
                  <td className="num">{fmtNum.format(b.transferOut)}</td>
                  <td className="num">
                    <span className={`ip-closing ${b.closing <= 0 ? "is-zero" : ""}`}>{fmtNum.format(b.closing)}</span>
                  </td>
                  <td className="num">
                    {b.sellThroughPct !== null ? (
                      <span
                        className={`ip-sell-badge ${
                          b.sellThroughPct >= 70
                            ? "is-high"
                            : b.sellThroughPct >= 30
                              ? "is-mid"
                              : "is-low"
                        }`}
                      >
                        {fmtNum.format(b.sellThroughPct)}%
                      </span>
                    ) : (
                      <span className="ip-sell-empty">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
