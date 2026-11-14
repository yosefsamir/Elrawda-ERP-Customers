import { useEffect, useMemo, useState } from "react";
import {
  fetchProductCard,
  UnauthorizedError,
  type ItemPerformanceRow,
  type ProductCardResponse,
} from "../../shared/api/reports";
import "./product-card.css";

export type ProductCardTarget = {
  productId: string;
  code: string;
  description: string;
  itemType: string;
  section: string;
  classification: string;
};

type ProductCardModalProps = {
  target: ProductCardTarget | null;
  reportRows: ItemPerformanceRow[];
  onClose: () => void;
  onUnauthorized?: (message?: string) => void;
};

function formatNum(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function ProductCardModal({ target, reportRows, onClose, onUnauthorized }: ProductCardModalProps) {
  const [card, setCard] = useState<ProductCardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [activeImageIdx, setActiveImageIdx] = useState(0);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target, onClose]);

  useEffect(() => {
    if (!target) {
      setCard(null);
      setError(undefined);
      setActiveImageIdx(0);
      return;
    }
    const controller = new AbortController();
    setCard(null);
    setLoading(true);
    setError(undefined);
    setActiveImageIdx(0);
    fetchProductCard(target.productId, target.code, controller.signal)
      .then(data => {
        if (!controller.signal.aborted) setCard(data);
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          if (reason instanceof UnauthorizedError) {
            onUnauthorized?.(reason.message);
            onClose();
            return;
          }
          setError(reason instanceof Error ? reason.message : "تعذر تحميل بيانات الصنف.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [target, onClose, onUnauthorized]);

  const branchSummary = useMemo(() => {
    if (!target) return { branches: [], totalClosing: 0, totalNetSold: 0, sellThroughPct: null as number | null, ratePerDay: null as number | null };
    const matching = reportRows.filter(r => r.productId === target.productId);
    const byBranch = new Map<
      string,
      { branchId: string; branchName: string; closing: number; netSold: number; availableDays: number }
    >();
    let totalClosing = 0;
    let totalNetSold = 0;
    let totalOpeningAndInbound = 0;
    let maxAvailableDays = 0;

    for (const r of matching) {
      totalClosing += r.closing;
      totalNetSold += r.netSold;
      totalOpeningAndInbound += r.opening + r.inbound + r.transferIn + Math.max(0, r.otherMovements);
      maxAvailableDays = Math.max(maxAvailableDays, r.availableDays);

      const prev = byBranch.get(r.branchId);
      if (!prev) {
        byBranch.set(r.branchId, {
          branchId: r.branchId,
          branchName: r.branchName,
          closing: r.closing,
          netSold: r.netSold,
          availableDays: r.availableDays,
        });
      } else {
        prev.closing += r.closing;
        prev.netSold += r.netSold;
        prev.availableDays = Math.max(prev.availableDays, r.availableDays);
      }
    }

    const branches = Array.from(byBranch.values())
      .map(b => {
        const rate = b.netSold > 0 && b.availableDays > 0 ? b.netSold / b.availableDays : 0;
        const coverDays = rate > 0 ? Math.max(0, b.closing) / rate : null;
        return { ...b, coverDays };
      })
      .sort((a, b) => b.closing - a.closing || b.netSold - a.netSold);

    const sellThroughPct =
      totalOpeningAndInbound > 0 ? (totalNetSold / totalOpeningAndInbound) * 100 : null;
    const ratePerDay = maxAvailableDays > 0 && totalNetSold >= 0 ? totalNetSold / maxAvailableDays : null;

    return { branches, totalClosing, totalNetSold, sellThroughPct, ratePerDay };
  }, [target, reportRows]);

  if (!target) return null;

  const images = card?.images ?? [];
  const activeImage = images[activeImageIdx] ?? null;

  return (
    <div
      className="pc-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`بطاقة الصنف ${target.description}`}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pc-modal">
        <div className="pc-header">
          <div className="pc-header-title">
            <h2>{card?.erp?.description || target.description}</h2>
            <div className="pc-header-meta">
              <span className="pc-code-tag">{target.code || "—"}</span>
              {target.itemType && <span>· {target.itemType}</span>}
              {target.section && <span>· {target.section}</span>}
              {target.classification && <span>· {target.classification}</span>}
            </div>
          </div>
          <button type="button" className="pc-close-btn" onClick={onClose} aria-label="إغلاق">
            ×
          </button>
        </div>

        <div className="pc-body">
          <div className="pc-top-grid">
            <div className="pc-gallery">
              <div className="pc-main-img-box">
                {loading && !card ? (
                  <div className="pc-img-empty">جارٍ تحميل الصورة…</div>
                ) : activeImage ? (
                  <img src={activeImage.url} alt={target.description} />
                ) : (
                  <div className="pc-img-empty">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                    <span>لا توجد صورة مسجلة لهذا الصنف</span>
                  </div>
                )}
              </div>
              {images.length > 1 && (
                <div className="pc-thumbs">
                  {images.map((img, idx) => (
                    <button
                      key={img.id}
                      type="button"
                      className={`pc-thumb-btn ${idx === activeImageIdx ? "is-active" : ""}`}
                      onClick={() => setActiveImageIdx(idx)}
                      aria-label={`صورة ${idx + 1}`}
                    >
                      <img src={img.url} alt="" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="pc-info-col">
              {error && (
                <div className="rf-report-error" role="alert">
                  {error}
                </div>
              )}

              {card?.erp && card.erp.price !== null && (
                <div className="pc-price-row">
                  <span className="pc-price-val">{formatNum(card.erp.price, 2)} ج.م</span>
                  {card.erp.unit && <span className="pc-unit-label">/ {card.erp.unit}</span>}
                </div>
              )}

              <div className="pc-kpis">
                <div className="pc-kpi">
                  <div className="pc-kpi-label">إجمالي الرصيد الحالي</div>
                  <div className="pc-kpi-val">{formatNum(branchSummary.totalClosing)} قطعة</div>
                </div>
                <div className="pc-kpi">
                  <div className="pc-kpi-label">إجمالي صافي المبيعات</div>
                  <div className="pc-kpi-val">{formatNum(branchSummary.totalNetSold)} قطعة</div>
                </div>
                <div className="pc-kpi">
                  <div className="pc-kpi-label">نسبة التصريف</div>
                  <div className="pc-kpi-val">
                    {branchSummary.sellThroughPct !== null ? `${formatNum(branchSummary.sellThroughPct, 1)}%` : "—"}
                  </div>
                </div>
                <div className="pc-kpi">
                  <div className="pc-kpi-label">معدل البيع اليومي</div>
                  <div className="pc-kpi-val">
                    {branchSummary.ratePerDay !== null ? `${formatNum(branchSummary.ratePerDay, 2)} / يوم` : "—"}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {branchSummary.branches.length > 0 && (
            <div>
              <div className="pc-branches-title">
                توزيع الصنف على الفروع في التقرير الحالي ({branchSummary.branches.length})
              </div>
              <div className="pc-branches-wrap">
                <table className="pc-branches-table">
                  <thead>
                    <tr>
                      <th>الفرع</th>
                      <th>الرصيد الحالي</th>
                      <th>صافي المبيعات</th>
                      <th>التغطية</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branchSummary.branches.map(b => (
                      <tr key={b.branchId}>
                        <td>{b.branchName}</td>
                        <td>{formatNum(b.closing)}</td>
                        <td>{formatNum(b.netSold)}</td>
                        <td>
                          {b.closing <= 0 && b.netSold > 0
                            ? "خلصان (0)"
                            : b.coverDays !== null
                              ? `يكفي ${formatNum(b.coverDays, 0)} يوم`
                              : b.closing > 0
                                ? "راكد"
                                : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
