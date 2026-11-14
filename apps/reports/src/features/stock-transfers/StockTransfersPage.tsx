import { useMemo, useState } from "react";
import type { LocationOption } from "../../components/catalog-filter/model";
import type { ItemPerformanceReport } from "../../shared/api/reports";
import type { ProductCardTarget } from "../product-card";
import { exportTransfersCsv } from "./csvExport";
import {
  computeTransferPlan,
  DEFAULT_TRANSFER_SETTINGS,
  type BranchTransferRole,
  type TransferSettings,
} from "./model";
import "./stock-transfers.css";

type StockTransfersPageProps = {
  report: ItemPerformanceReport | null;
  reportLoading: boolean;
  reportError?: string;
  locations: LocationOption[];
  from: string;
  through: string;
  onRunReport: () => void;
  onOpenFilter: () => void;
  onInspectProduct?: (target: ProductCardTarget) => void;
};

const ROLE_LABELS: Record<BranchTransferRole, string> = {
  both: "يُرسِل ويستقبل",
  send_only: "مُرسِل فقط",
  receive_only: "مُستقبِل فقط",
  excluded: "مستبعد",
};

function formatNum(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function StockTransfersPage({
  report,
  reportLoading,
  reportError,
  locations,
  from,
  through,
  onRunReport,
  onOpenFilter,
  onInspectProduct,
}: StockTransfersPageProps) {
  const [settings, setSettings] = useState<TransferSettings>(DEFAULT_TRANSFER_SETTINGS);
  const [viewMode, setViewMode] = useState<"routes" | "items">("routes");
  const [searchQuery, setSearchQuery] = useState("");
  const [showBranchRoles, setShowBranchRoles] = useState(false);

  const plan = useMemo(() => {
    if (!report) return null;
    return computeTransferPlan(report.rows, settings);
  }, [report, settings]);

  const filteredSuggestions = useMemo(() => {
    if (!plan) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return plan.suggestions;
    return plan.suggestions.filter(
      s =>
        s.code.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.fromBranchName.toLowerCase().includes(q) ||
        s.toBranchName.toLowerCase().includes(q) ||
        s.section.toLowerCase().includes(q) ||
        s.classification.toLowerCase().includes(q),
    );
  }, [plan, searchQuery]);

  const filteredRoutes = useMemo(() => {
    if (!plan) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return plan.routes;
    return plan.routes
      .map(route => {
        const items = route.items.filter(
          s =>
            s.code.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.fromBranchName.toLowerCase().includes(q) ||
            s.toBranchName.toLowerCase().includes(q) ||
            s.section.toLowerCase().includes(q) ||
            s.classification.toLowerCase().includes(q),
        );
        return {
          ...route,
          items,
          itemCount: items.length,
          totalQuantity: items.reduce((acc, item) => acc + item.quantity, 0),
        };
      })
      .filter(route => route.items.length > 0);
  }, [plan, searchQuery]);

  const updateBranchRole = (branchId: string, role: BranchTransferRole) => {
    setSettings(prev => ({
      ...prev,
      branchRoles: {
        ...prev.branchRoles,
        [branchId]: role,
      },
    }));
  };

  return (
    <div className="st-page">
      <section className="st-header-card">
        <div className="st-header-top">
          <div className="st-header-title">
            <h1>إعادة توزيع المخزون بين الفروع</h1>
            <p>
              تحليل أرصدة ومبيعات الفترة ({from} ← {through}) لاقتراح تحويلات من الفروع الراكدة أو ذات الفائض إلى الفروع التي أوشكت على النفاد.
            </p>
          </div>
          <div className="st-header-actions">
            <button type="button" className="st-btn-secondary" onClick={onOpenFilter}>
              تعديل الفلتر والفترة
            </button>
            <button
              type="button"
              className="st-btn-primary"
              disabled={reportLoading}
              onClick={onRunReport}
            >
              {reportLoading ? "جارٍ التحديث…" : report ? "تحديث البيانات" : "حساب مقترحات التحويل"}
            </button>
            {filteredSuggestions.length > 0 && (
              <button
                type="button"
                className="st-btn-secondary"
                onClick={() => exportTransfersCsv(filteredSuggestions, from, through, "stock_transfers")}
              >
                تصدير الكل (CSV)
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="st-settings-card">
        <div className="st-settings-grid">
          <label className="st-field">
            ابعت للفرع لو البضاعة تكفيه أقل من (أيام)
            <input
              type="number"
              min={0}
              max={60}
              value={settings.shortageCoverDays}
              onChange={e =>
                setSettings(prev => ({ ...prev, shortageCoverDays: Number(e.target.value) || 0 }))
              }
            />
          </label>
          <label className="st-field">
            كمّله بضاعة تكفيه (أيام)
            <input
              type="number"
              min={1}
              max={120}
              value={settings.targetCoverDays}
              onChange={e =>
                setSettings(prev => ({ ...prev, targetCoverDays: Number(e.target.value) || 1 }))
              }
            />
          </label>
          <label className="st-field">
            اسحب من الفرع لو بضاعته تكفي أكتر من (أيام)
            <input
              type="number"
              min={1}
              max={365}
              value={settings.surplusCoverDays}
              onChange={e =>
                setSettings(prev => ({ ...prev, surplusCoverDays: Number(e.target.value) || 1 }))
              }
            />
          </label>
          <label className="st-field">
            سيب في الفرع المسحوب منه (أيام)
            <input
              type="number"
              min={0}
              max={180}
              value={settings.safetyKeepDays}
              onChange={e =>
                setSettings(prev => ({ ...prev, safetyKeepDays: Number(e.target.value) || 0 }))
              }
            />
          </label>
          <label className="st-field">
            لو الصنف راكد سيب منه (قطعة)
            <input
              type="number"
              min={0}
              max={10}
              value={settings.stagnantKeepQty}
              disabled={!settings.includeStagnantSurplus}
              onChange={e =>
                setSettings(prev => ({ ...prev, stagnantKeepQty: Number(e.target.value) || 0 }))
              }
            />
          </label>
          <label className="st-checkbox-field">
            <input
              type="checkbox"
              checked={settings.includeStagnantSurplus}
              onChange={e =>
                setSettings(prev => ({ ...prev, includeStagnantSurplus: e.target.checked }))
              }
            />
            <span>اسحب من الأصناف الراكدة (مبيعاتها 0)</span>
          </label>
        </div>

        {locations.length > 0 && (
          <div className="st-roles-section">
            <button
              type="button"
              className="st-btn-secondary"
              onClick={() => setShowBranchRoles(prev => !prev)}
            >
              {showBranchRoles ? "إخفاء أدوار الفروع" : `تخصيص أدوار الفروع (${locations.length})`}
            </button>
            {showBranchRoles && (
              <div className="st-roles-grid" style={{ marginTop: "10px" }}>
                {locations.map(loc => {
                  const role = settings.branchRoles[loc.id] ?? "both";
                  return (
                    <div key={loc.id} className="st-role-item">
                      <span title={loc.label}>{loc.label}</span>
                      <select
                        value={role}
                        onChange={e => updateBranchRole(loc.id, e.target.value as BranchTransferRole)}
                      >
                        {(Object.keys(ROLE_LABELS) as BranchTransferRole[]).map(key => (
                          <option key={key} value={key}>
                            {ROLE_LABELS[key]}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {reportError && (
        <div className="rf-report-error" role="alert">
          {reportError}
        </div>
      )}

      {!report && !reportLoading && (
        <div className="st-empty">
          اضغط على <strong>«حساب مقترحات التحويل»</strong> أعلاه لتحليل أرصدة ومبيعات الفترة الحالية وعرض التحويلات المقترحة.
        </div>
      )}

      {reportLoading && <div className="rf-report-loading">جارٍ تحليل الأرصدة وحساب مقترحات التحويل…</div>}

      {plan && !reportLoading && (
        <>
          <section className="st-kpis">
            <div className="st-kpi">
              <div className="st-kpi-label">عدد التحويلات المقترحة</div>
              <div className="st-kpi-value">{formatNum(plan.totalSuggestions)}</div>
            </div>
            <div className="st-kpi">
              <div className="st-kpi-label">إجمالي القطع المقترح نقلها</div>
              <div className="st-kpi-value">{formatNum(plan.totalQuantity)}</div>
            </div>
            <div className="st-kpi">
              <div className="st-kpi-label">الأصناف المتأثرة</div>
              <div className="st-kpi-value">{formatNum(plan.uniqueProductCount)}</div>
            </div>
            <div className="st-kpi">
              <div className="st-kpi-label">عدد المسارات (من فرع ← إلى فرع)</div>
              <div className="st-kpi-value">{formatNum(plan.routeCount)}</div>
            </div>
          </section>

          <div className="st-toolbar">
            <div className="st-view-switch" role="tablist">
              <button
                type="button"
                className={viewMode === "routes" ? "is-active" : ""}
                onClick={() => setViewMode("routes")}
              >
                حسب المسار ({filteredRoutes.length})
              </button>
              <button
                type="button"
                className={viewMode === "items" ? "is-active" : ""}
                onClick={() => setViewMode("items")}
              >
                تفصيلي حسب الصنف ({filteredSuggestions.length})
              </button>
            </div>
            <input
              type="search"
              className="st-search-input"
              placeholder="ابحث بكود أو اسم الصنف أو الفرع…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          {filteredSuggestions.length === 0 ? (
            <div className="st-empty">
              لا توجد اقتراحات تحويل مطابقة للإعدادات الحالية. جرّب توسيع الفترة أو تعديل حدود التغطية.
            </div>
          ) : viewMode === "routes" ? (
            <div className="st-routes-list">
              {filteredRoutes.map(route => (
                <section key={route.routeKey} className="st-route-card">
                  <div className="st-route-header">
                    <div className="st-route-title">
                      <span>من: {route.fromBranchName}</span>
                      <span>←</span>
                      <span>إلى: {route.toBranchName}</span>
                      <span className="st-route-badge">
                        {formatNum(route.itemCount)} صنف · {formatNum(route.totalQuantity)} قطعة
                      </span>
                    </div>
                    <button
                      type="button"
                      className="st-icon-btn"
                      title="تصدير هذا المسار (CSV)"
                      aria-label="تصدير هذا المسار (CSV)"
                      onClick={() =>
                        exportTransfersCsv(
                          route.items,
                          from,
                          through,
                          `transfer_${route.fromBranchId}_to_${route.toBranchId}`,
                        )
                      }
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                  </div>
                  <div className="st-table-wrap">
                    <table className="st-table">
                      <thead>
                        <tr className="st-group-head">
                          <th colSpan={3}>بيانات الصنف</th>
                          <th colSpan={3} className="st-th-from">
                            في {route.fromBranchName} (هيتسحب منه)
                          </th>
                          <th colSpan={3} className="st-th-to">
                            في {route.toBranchName} (محتاج بضاعة)
                          </th>
                        </tr>
                        <tr>
                          <th>الكود</th>
                          <th>الصنف</th>
                          <th>حوّل</th>
                          <th className="st-cell-group-start">الرصيد</th>
                          <th>المباع</th>
                          <th>الوضع</th>
                          <th className="st-cell-group-start">الرصيد</th>
                          <th>المباع</th>
                          <th>الوضع</th>
                        </tr>
                      </thead>
                      <tbody>
                        {route.items.map(item => (
                          <tr key={item.id}>
                            <td>
                              {onInspectProduct ? (
                                <button
                                  type="button"
                                  className="pc-code-link"
                                  onClick={() =>
                                    onInspectProduct({
                                      productId: item.productId,
                                      code: item.code,
                                      description: item.description,
                                      itemType: item.itemType,
                                      section: item.section,
                                      classification: item.classification,
                                    })
                                  }
                                >
                                  {item.code && item.code !== "*" ? item.code : `#${item.productId}`}
                                </button>
                              ) : (
                                item.code || "—"
                              )}
                            </td>
                            <td>
                              <span>{item.description}</span>
                              {item.section && <span className="st-item-sub">{item.section}</span>}
                            </td>
                            <td>
                              <span className="st-qty-pill">{formatNum(item.quantity)} قطعة</span>
                            </td>
                            <td className="st-cell-group-start">{formatNum(item.fromClosing)}</td>
                            <td>{formatNum(item.fromNetSold)}</td>
                            <td>
                              <span
                                className={`st-reason-pill ${
                                  item.fromReason === "راكد" ? "is-stagnant" : "is-surplus"
                                }`}
                              >
                                {item.fromReason === "راكد"
                                  ? "راكد"
                                  : `يكفي ${formatNum(item.fromCoverDays, 0)} يوم`}
                              </span>
                            </td>
                            <td className="st-cell-group-start">{formatNum(item.toClosing)}</td>
                            <td>{formatNum(item.toNetSold)}</td>
                            <td>
                              <span className={`st-status-text ${item.toClosing <= 0 ? "is-empty" : "is-low"}`}>
                                {item.toClosing <= 0
                                  ? "خلصان (0)"
                                  : `يكفي ${formatNum(item.toCoverDays, 0)} يوم`}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <section className="st-table-card">
              <div className="st-table-wrap">
                <table className="st-table">
                  <thead>
                    <tr>
                      <th>من فرع</th>
                      <th>إلى فرع</th>
                      <th>الكود</th>
                      <th>الصنف</th>
                      <th>حوّل</th>
                      <th>وضع الفرع المسحوب منه</th>
                      <th>وضع الفرع المحتاج</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSuggestions.map(item => (
                      <tr key={item.id}>
                        <td>{item.fromBranchName}</td>
                        <td>{item.toBranchName}</td>
                        <td>
                          {onInspectProduct ? (
                            <button
                              type="button"
                              className="pc-code-link"
                              onClick={() =>
                                onInspectProduct({
                                  productId: item.productId,
                                  code: item.code,
                                  description: item.description,
                                  itemType: item.itemType,
                                  section: item.section,
                                  classification: item.classification,
                                })
                              }
                            >
                              {item.code && item.code !== "*" ? item.code : `#${item.productId}`}
                            </button>
                          ) : (
                            item.code || "—"
                          )}
                        </td>
                        <td>
                          <span>{item.description}</span>
                          {item.section && <span className="st-item-sub">{item.section}</span>}
                        </td>
                        <td>
                          <span className="st-qty-pill">{formatNum(item.quantity)} قطعة</span>
                        </td>
                        <td>
                          <span
                            className={`st-reason-pill ${
                              item.fromReason === "راكد" ? "is-stagnant" : "is-surplus"
                            }`}
                          >
                            {item.fromReason === "راكد"
                              ? `راكد (رصيد ${formatNum(item.fromClosing)})`
                              : `رصيد ${formatNum(item.fromClosing)} · يكفي ${formatNum(item.fromCoverDays, 0)} يوم`}
                          </span>
                        </td>
                        <td>
                          {item.toClosing <= 0
                            ? `خلصان (باع ${formatNum(item.toNetSold)})`
                            : `رصيد ${formatNum(item.toClosing)} · يكفي ${formatNum(item.toCoverDays, 0)} يوم`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
