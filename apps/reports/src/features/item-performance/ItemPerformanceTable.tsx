import { useMemo, useState } from "react";
import type { ItemPerformanceRow } from "../../shared/api/reports";
import type { ProductCardTarget } from "../product-card";
import { exportItemPerformanceCsv } from "./csvExport";
import { GROUP_BY_LABELS, groupItemPerformanceRows, type DisplayPerformanceRow, type GroupByLevel } from "./grouping";

type StatusFilter = "all" | "low-cover" | "stagnant" | "zero-sales" | "in-stock" | "out-of-stock";
type SortOption = "netSold-desc" | "sellThrough-desc" | "closing-desc" | "netSold-asc";

const fmtNum = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmtRate = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const PAGE_SIZE = 100;

type Props = {
  rows: ItemPerformanceRow[];
  from: string;
  to: string;
  groupBy?: GroupByLevel | null;
  groupByBranch?: boolean;
  onClearGroupBy?: () => void;
  onClearGroupByBranch?: () => void;
  onSelectRow?: (row: ItemPerformanceRow) => void;
  onSelectGroup?: (row: DisplayPerformanceRow) => void;
  onInspectProduct?: (target: ProductCardTarget) => void;
};

function matchesStatus(r: DisplayPerformanceRow, status: StatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "low-cover":
      return r.closing > 0 && r.coverDays !== null && r.coverDays <= 7;
    case "stagnant":
      return r.closing > 0 && r.netSold <= 0;
    case "zero-sales":
      return r.netSold <= 0;
    case "in-stock":
      return r.closing > 0;
    case "out-of-stock":
      return r.closing <= 0;
  }
}

export function ItemPerformanceTable({
  rows,
  from,
  to,
  groupBy = null,
  groupByBranch = false,
  onClearGroupBy,
  onClearGroupByBranch,
  onSelectRow,
  onSelectGroup,
  onInspectProduct,
}: Props) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("netSold-desc");
  const [search, setSearch] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);

  const groupedRows = useMemo(
    () => groupItemPerformanceRows(rows, groupBy, groupByBranch),
    [rows, groupBy, groupByBranch],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      all: groupedRows.length,
      "low-cover": 0,
      stagnant: 0,
      "zero-sales": 0,
      "in-stock": 0,
      "out-of-stock": 0,
    };
    for (const r of groupedRows) {
      if (matchesStatus(r, "low-cover")) counts["low-cover"] += 1;
      if (matchesStatus(r, "stagnant")) counts.stagnant += 1;
      if (matchesStatus(r, "zero-sales")) counts["zero-sales"] += 1;
      if (matchesStatus(r, "in-stock")) counts["in-stock"] += 1;
      if (matchesStatus(r, "out-of-stock")) counts["out-of-stock"] += 1;
    }
    return counts;
  }, [groupedRows]);

  const filteredAndSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = groupedRows.filter(r => {
      if (!matchesStatus(r, statusFilter)) return false;
      if (q) {
        const haystack = `${r.code} ${r.productId} ${r.description} ${r.itemType} ${r.section} ${r.classification} ${r.branchName} ${r.storeName}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortBy === "netSold-desc") return b.netSold - a.netSold || b.closing - a.closing;
      if (sortBy === "netSold-asc") return a.netSold - b.netSold || b.closing - a.closing;
      if (sortBy === "closing-desc") return b.closing - a.closing || b.netSold - a.netSold;
      // sellThrough-desc
      const sa = a.sellThroughPct ?? -1;
      const sb = b.sellThroughPct ?? -1;
      return sb - sa || b.netSold - a.netSold;
    });
    return sorted;
  }, [groupedRows, statusFilter, sortBy, search]);

  const visibleRows = filteredAndSorted.slice(0, visibleLimit);

  return (
    <section className="ip-results-section" aria-label="نتائج تقرير أداء الأصناف">
      <div className="ip-toolbar">
        <div className="ip-status-pills" role="group" aria-label="تصفية سريعة">
          {[
            { id: "all" as const, label: "الكل" },
            { id: "low-cover" as const, label: "أوشك على النفاد" },
            { id: "stagnant" as const, label: "راكد" },
            { id: "zero-sales" as const, label: "بلا بيع" },
            { id: "in-stock" as const, label: "رصيد موجب" },
            { id: "out-of-stock" as const, label: "نفد بنهاية الفترة" },
          ].map(opt => (
            <button
              key={opt.id}
              type="button"
              className={`ip-pill ${statusFilter === opt.id ? "is-active" : ""}`}
              onClick={() => { setStatusFilter(opt.id); setVisibleLimit(PAGE_SIZE); }}
            >
              <span>{opt.label}</span>
              <span className="ip-pill-count">{fmtNum.format(statusCounts[opt.id])}</span>
            </button>
          ))}
        </div>

        <div className="ip-toolbar-actions">
          <div className="ip-search-box">
            <input
              type="search"
              placeholder="بحث بالكود أو الوصف أو الفرع…"
              value={search}
              onChange={e => { setSearch(e.target.value); setVisibleLimit(PAGE_SIZE); }}
            />
          </div>

          <select
            aria-label="ترتيب النتائج"
            className="ip-select"
            value={sortBy}
            onChange={e => setSortBy(e.target.value as SortOption)}
          >
            <option value="netSold-desc">الأكثر مبيعاً</option>
            <option value="sellThrough-desc">أعلى نسبة تصريف</option>
            <option value="closing-desc">أعلى رصيد متبقي</option>
            <option value="netSold-asc">الأقل مبيعاً</option>
          </select>

          <button
            type="button"
            className={`ip-btn-outline ${showDetails ? "is-active" : ""}`}
            onClick={() => setShowDetails(v => !v)}
          >
            <span>الأعمدة التفصيلية</span>
          </button>

          <button
            type="button"
            className="ip-btn-outline"
            disabled={filteredAndSorted.length === 0}
            onClick={() => exportItemPerformanceCsv(filteredAndSorted, from, to)}
          >
            <span>تصدير CSV</span>
          </button>
        </div>
      </div>

      <div className="ip-count-bar">
        <span>عرض {fmtNum.format(visibleRows.length)} من أصل {fmtNum.format(filteredAndSorted.length)} سطر</span>
        {(groupBy || groupByBranch) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {groupBy && (
              <span className="ip-group-badge">
                مجمّع حسب: <strong>{GROUP_BY_LABELS[groupBy]}</strong>
                {onClearGroupBy && (
                  <button type="button" onClick={onClearGroupBy} aria-label="إلغاء تجميع الأصناف">
                    إلغاء ×
                  </button>
                )}
              </span>
            )}
            {groupByBranch && (
              <span className="ip-group-badge">
                مجمّع حسب: <strong>الفروع</strong>
                {onClearGroupByBranch && (
                  <button type="button" onClick={onClearGroupByBranch} aria-label="إلغاء تجميع الفروع">
                    إلغاء ×
                  </button>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {filteredAndSorted.length === 0 ? (
        <div className="ip-empty">لا توجد نتائج مطابقة للتصفية الحالية.</div>
      ) : (
        <>
          <div className="ip-table-wrap">
            <table className="ip-table">
              <thead>
                <tr>
                  <th>{groupBy ? GROUP_BY_LABELS[groupBy] : "الصنف"}</th>
                  <th>الفرع / المخزن</th>
                  <th className="num">افتتاح</th>
                  {showDetails ? (
                    <>
                      <th className="num">وارد</th>
                      <th className="num">تحويل وارد</th>
                    </>
                  ) : (
                    <th className="num">الوارد</th>
                  )}
                  <th className="num">مباع</th>
                  <th className="num">مرتجع</th>
                  <th className="num">صافي البيع</th>
                  {showDetails && (
                    <>
                      <th className="num">تحويل صادر</th>
                      <th className="num">أخرى</th>
                    </>
                  )}
                  <th className="num">المتبقي</th>
                  <th className="num">التصريف</th>
                  <th className="num">أيام التوفر</th>
                  {showDetails && (
                    <>
                      <th className="num">معدل/يوم</th>
                      <th className="num">أيام التغطية</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row: DisplayPerformanceRow) => {
                  const isGrouped = row.groupCount !== undefined;
                  const clickable = Boolean(isGrouped ? onSelectGroup : onSelectRow);
                  const key = `${row.programId}-${row.branchId}-${row.storeId}-${row.productId}`;
                  const totalIn = row.inbound + row.transferIn;
                  return (
                    <tr
                      key={key}
                      className={clickable ? "is-clickable" : undefined}
                      onClick={clickable ? () => (isGrouped ? onSelectGroup?.(row) : onSelectRow?.(row)) : undefined}
                    >
                      <td>
                        <div className="ip-item-cell">
                          {isGrouped ? (
                            <>
                              <strong>{row.groupTitle}</strong>
                              <span className="ip-item-desc">{row.groupSubtitle}</span>
                              {row.groupPath && <span className="ip-item-path">{row.groupPath}</span>}
                            </>
                          ) : (
                            <>
                              {onInspectProduct ? (
                                <button
                                  type="button"
                                  className="pc-code-link"
                                  onClick={e => {
                                    e.stopPropagation();
                                    onInspectProduct({
                                      productId: row.productId,
                                      code: row.code,
                                      description: row.description,
                                      itemType: row.itemType,
                                      section: row.section,
                                      classification: row.classification,
                                    });
                                  }}
                                >
                                  {row.code && row.code !== "*" ? row.code : `#${row.productId}`}
                                </button>
                              ) : (
                                <strong>{row.code && row.code !== "*" ? row.code : `#${row.productId}`}</strong>
                              )}
                              <span className="ip-item-desc">{row.description || row.classification || row.section}</span>
                              <span className="ip-item-path">{[row.itemType, row.section, row.classification].filter(Boolean).join(" / ")} · #{row.productId}</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="ip-loc-cell">
                          <span>{row.branchName}</span>
                          <small>{row.storeName}</small>
                        </div>
                      </td>
                      <td className="num">{fmtNum.format(row.opening)}</td>
                      {showDetails ? (
                        <>
                          <td className="num">{fmtNum.format(row.inbound)}</td>
                          <td className="num">{fmtNum.format(row.transferIn)}</td>
                        </>
                      ) : (
                        <td className="num">{fmtNum.format(totalIn)}</td>
                      )}
                      <td className="num">{fmtNum.format(row.sold)}</td>
                      <td className="num">{fmtNum.format(row.returnSold)}</td>
                      <td className="num"><strong>{fmtNum.format(row.netSold)}</strong></td>
                      {showDetails && (
                        <>
                          <td className="num">{fmtNum.format(row.transferOut)}</td>
                          <td className="num">{fmtNum.format(row.otherMovements)}</td>
                        </>
                      )}
                      <td className="num">
                        <span className={`ip-closing ${row.closing <= 0 ? "is-zero" : ""}`}>{fmtNum.format(row.closing)}</span>
                      </td>
                      <td className="num">
                        {row.sellThroughPct !== null ? (
                          <span
                            className={`ip-sell-badge ${
                              row.sellThroughPct >= 70
                                ? "is-high"
                                : row.sellThroughPct >= 30
                                  ? "is-mid"
                                  : "is-low"
                            }`}
                          >
                            {fmtRate.format(row.sellThroughPct)}%
                          </span>
                        ) : (
                          <span className="ip-sell-empty">—</span>
                        )}
                      </td>
                      <td className="num">{row.availableDays} / {row.periodDays}</td>
                      {showDetails && (
                        <>
                          <td className="num">{row.ratePerDay !== null ? fmtRate.format(row.ratePerDay) : "—"}</td>
                          <td className="num">{row.coverDays !== null ? fmtRate.format(row.coverDays) : "—"}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {visibleLimit < filteredAndSorted.length && (
            <div className="ip-load-more">
              <button type="button" className="ip-btn-outline" onClick={() => setVisibleLimit(v => v + PAGE_SIZE)}>
                عرض المزيد ({fmtNum.format(filteredAndSorted.length - visibleLimit)} متبقي)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
