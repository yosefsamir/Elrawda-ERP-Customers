import { useEffect, useMemo, useState } from "react";
import type { ItemPerformanceRow } from "../../shared/api/reports";
import type { ProductCardTarget } from "../product-card";
import { GROUP_BY_LABELS, type DisplayPerformanceRow, type GroupByLevel } from "./grouping";

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

type Props = {
  groupRow: DisplayPerformanceRow | null;
  groupBy: GroupByLevel | null;
  suppressEscape?: boolean;
  onClose: () => void;
  onSelectItem: (row: ItemPerformanceRow) => void;
  onInspectProduct?: (target: ProductCardTarget) => void;
};

export function GroupDetailsDrawer({
  groupRow,
  groupBy,
  suppressEscape = false,
  onClose,
  onSelectItem,
  onInspectProduct,
}: Props) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    setQuery("");
  }, [groupRow?.productId]);

  useEffect(() => {
    if (!groupRow || suppressEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groupRow, suppressEscape, onClose]);

  const members = groupRow?.memberRows ?? [];
  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(r =>
      `${r.code} ${r.productId} ${r.description} ${r.classification} ${r.section} ${r.branchName} ${r.storeName}`
        .toLowerCase()
        .includes(q),
    );
  }, [members, query]);

  if (!groupRow) return null;

  const headerLabel = groupBy ? GROUP_BY_LABELS[groupBy] : "تجميع الفروع";

  return (
    <div
      className="rf-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`تفاصيل ${groupRow.groupTitle ?? groupRow.code}`}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="rf-drawer ip-group-drawer">
        <div className="rf-drawer-header">
          <strong>
            <span>
              {headerLabel} · {groupRow.groupTitle ?? groupRow.code}
            </span>
          </strong>
          <button
            type="button"
            className="rf-drawer-close"
            onClick={onClose}
            aria-label="إغلاق تفاصيل المجموعة"
          >
            ×
          </button>
        </div>

        <div className="rf-drawer-body">
          <div className="ip-ledger-meta">
            <strong>{groupRow.branchName}</strong>
            <span>{groupRow.storeName}</span>
            {groupRow.groupPath && <span>{groupRow.groupPath}</span>}
          </div>

          <div className="ip-ledger-kpis">
            <div>
              <span>الأصناف</span>
              <strong>{fmt.format(groupRow.groupCount ?? members.length)}</strong>
            </div>
            <div>
              <span>صافي البيع</span>
              <strong className="is-accent">{fmt.format(groupRow.netSold)}</strong>
            </div>
            <div>
              <span>المتبقي</span>
              <strong className={groupRow.closing <= 0 ? "is-zero" : ""}>
                {fmt.format(groupRow.closing)}
              </strong>
            </div>
            <div>
              <span>التصريف</span>
              <strong>
                {groupRow.sellThroughPct !== null ? `${fmt.format(groupRow.sellThroughPct)}%` : "—"}
              </strong>
            </div>
          </div>

          {members.length > 5 && (
            <div className="ip-group-search">
              <input
                type="search"
                placeholder="ابحث داخل المجموعة بالكود أو المقاس أو المخزن…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
          )}

          {filteredMembers.length === 0 ? (
            <div className="ip-empty">لا توجد أصناف مطابقة للبحث.</div>
          ) : (
            <div className="ip-group-list">
              {filteredMembers.map(item => {
                const title = item.code && item.code !== "*" ? item.code : `#${item.productId}`;
                const sellBadgeClass =
                  item.sellThroughPct === null
                    ? ""
                    : item.sellThroughPct >= 70
                      ? "is-high"
                      : item.sellThroughPct >= 30
                        ? "is-mid"
                        : "is-low";
                return (
                  <button
                    key={`${item.programId}-${item.branchId}-${item.storeId}-${item.productId}`}
                    type="button"
                    className="ip-group-item-card"
                    onClick={() => onSelectItem(item)}
                  >
                    <div className="ip-group-item-top">
                      <div>
                        {onInspectProduct ? (
                          <span
                            role="button"
                            tabIndex={0}
                            className="pc-code-link"
                            onClick={e => {
                              e.stopPropagation();
                              onInspectProduct({
                                productId: item.productId,
                                code: item.code,
                                description: item.description,
                                itemType: item.itemType,
                                section: item.section,
                                classification: item.classification,
                              });
                            }}
                            onKeyDown={e => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                onInspectProduct({
                                  productId: item.productId,
                                  code: item.code,
                                  description: item.description,
                                  itemType: item.itemType,
                                  section: item.section,
                                  classification: item.classification,
                                });
                              }
                            }}
                          >
                            {title}
                          </span>
                        ) : (
                          <strong>{title}</strong>
                        )}
                        <div className="ip-item-name-row">
                          <span className="ip-group-item-sub">
                            {item.description || item.classification || item.section}
                            {item.branchName ? ` · ${item.branchName}` : ""}
                            {item.storeName ? ` (${item.storeName})` : ""}
                          </span>
                          {item.price != null && item.price > 0 && (
                            <span className="ip-item-price">{fmt.format(item.price)} ج.م</span>
                          )}
                        </div>
                      </div>
                      {item.sellThroughPct !== null ? (
                        <span className={`ip-sell-badge ${sellBadgeClass}`}>
                          {fmt.format(item.sellThroughPct)}%
                        </span>
                      ) : (
                        <span className="ip-sell-empty">—</span>
                      )}
                    </div>

                    <div className="ip-group-item-stats">
                      <div>
                        <span>افتتاح</span>
                        <strong>{fmt.format(item.opening)}</strong>
                      </div>
                      <div>
                        <span>صافي البيع</span>
                        <strong>{fmt.format(item.netSold)}</strong>
                      </div>
                      <div>
                        <span>المتبقي</span>
                        <strong className={item.closing <= 0 ? "is-zero" : ""}>
                          {fmt.format(item.closing)}
                        </strong>
                      </div>
                      <div>
                        <span>التغطية</span>
                        <strong>
                          {item.coverDays !== null ? `${fmt.format(item.coverDays)} ي` : "—"}
                        </strong>
                      </div>
                    </div>

                    <div className="ip-group-item-foot">
                      <span>#{item.productId}</span>
                      <span>عرض كارت الصنف ←</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
