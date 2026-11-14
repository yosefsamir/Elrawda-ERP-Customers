import { useEffect } from "react";
import type { ItemLedgerReport, ItemPerformanceRow } from "../../shared/api/reports";

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

type Props = {
  selectedRow: ItemPerformanceRow | null;
  ledger: ItemLedgerReport | null;
  loading: boolean;
  error?: string;
  onClose: () => void;
};

export function ItemLedgerDrawer({ selectedRow, ledger, loading, error, onClose }: Props) {
  useEffect(() => {
    if (!selectedRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRow, onClose]);

  if (!selectedRow) return null;

  const titleCode = selectedRow.code && selectedRow.code !== "*" ? selectedRow.code : `#${selectedRow.productId}`;

  return (
    <div
      className="rf-drawer-backdrop ip-ledger-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="كارت حركة الصنف"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="rf-drawer ip-ledger-drawer">
        <div className="rf-drawer-header">
          <strong>
            <span>كارت الصنف · {titleCode}</span>
          </strong>
          <button type="button" className="rf-drawer-close" onClick={onClose} aria-label="إغلاق كارت الصنف">
            ×
          </button>
        </div>

        <div className="rf-drawer-body">
          <div className="ip-ledger-meta">
            <strong>{selectedRow.description || selectedRow.classification || selectedRow.section}</strong>
            <span>
              {[selectedRow.itemType, selectedRow.section, selectedRow.classification].filter(Boolean).join(" / ")} · #{selectedRow.productId}
            </span>
            <span>
              {selectedRow.branchName} — {selectedRow.storeName}
            </span>
          </div>

          {loading && <div className="rf-report-loading">جارٍ تحميل حركات الصنف…</div>}

          {error && (
            <div className="rf-report-error" role="alert">
              {error}
            </div>
          )}

          {ledger && !loading && (
            <>
              <div className="ip-ledger-kpis">
                <div>
                  <span>افتتاح ({ledger.meta.from})</span>
                  <strong>{fmt.format(ledger.opening)}</strong>
                </div>
                <div>
                  <span>إجمالي الوارد</span>
                  <strong className="is-in">+{fmt.format(ledger.totalInbound)}</strong>
                </div>
                <div>
                  <span>إجمالي الصادر</span>
                  <strong className="is-out">-{fmt.format(ledger.totalOutbound)}</strong>
                </div>
                <div>
                  <span>الرصيد ({ledger.meta.to})</span>
                  <strong className={ledger.closing <= 0 ? "is-zero" : "is-accent"}>{fmt.format(ledger.closing)}</strong>
                </div>
              </div>

              {ledger.entries.length === 0 ? (
                <div className="ip-empty">لا توجد حركات مسجلة لهذا الصنف خلال الفترة المحددة.</div>
              ) : (
                <div className="ip-table-wrap">
                  <table className="ip-table ip-ledger-table">
                    <thead>
                      <tr>
                        <th>التاريخ</th>
                        <th>الحركة</th>
                        <th className="num">المستند</th>
                        <th className="num">وارد</th>
                        <th className="num">صادر</th>
                        <th className="num">الرصيد</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.entries.map((entry, idx) => (
                        <tr key={`${entry.documentId}-${entry.lineId}-${idx}`}>
                          <td className="ip-ledger-date">{entry.date}</td>
                          <td>{entry.label}</td>
                          <td className="num">{entry.documentId}</td>
                          <td className="num">{entry.inbound > 0 ? fmt.format(entry.inbound) : "—"}</td>
                          <td className="num">{entry.outbound > 0 ? fmt.format(entry.outbound) : "—"}</td>
                          <td className="num">
                            <strong>{fmt.format(entry.balanceAfter)}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
