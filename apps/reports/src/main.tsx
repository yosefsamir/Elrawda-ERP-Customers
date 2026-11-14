import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CatalogFilter, defaultFilterValue, type CatalogFilterValue } from "./components/catalog-filter";
import {
  buildCatalogIndex,
  changeBranches,
  selectedLeaves,
  selectedLocationIds,
  validateFilter,
  type GroupByLevel,
} from "./components/catalog-filter/model";
import { GROUP_BY_LABELS, type DisplayPerformanceRow } from "./features/item-performance/grouping";
import {
  fetchFilterOptions,
  fetchItemLedger,
  fetchItemPerformance,
  fetchSession,
  loginReports,
  logoutReports,
  UnauthorizedError,
  type CatalogResponse,
  type ItemLedgerReport,
  type ItemPerformanceReport,
  type ItemPerformanceRow,
  type SessionState,
} from "./shared/api/reports";
import {
  GroupDetailsDrawer,
  ItemLedgerDrawer,
  ItemPerformanceSummaryCards,
  ItemPerformanceTable,
} from "./features/item-performance";
import { BranchComparisonTable } from "./features/branch-comparison";
import { ProductCardModal, type ProductCardTarget } from "./features/product-card";
import { StockTransfersPage } from "./features/stock-transfers";
import "./styles.css";
import "./features/item-performance/item-performance.css";

const FILTER_STORAGE_KEY = "emoji.reports.itemPerformance.filter.v1";
const APPLIED_STORAGE_KEY = "emoji.reports.itemPerformance.applied.v1";
const GROUP_BY_STORAGE_KEY = "emoji.reports.itemPerformance.groupBy.v1";
const GROUP_BY_BRANCH_STORAGE_KEY = "emoji.reports.itemPerformance.groupByBranch.v1";

function loadSavedGroupBy(): GroupByLevel | null {
  try {
    const raw = localStorage.getItem(GROUP_BY_STORAGE_KEY);
    if (raw === "type" || raw === "section" || raw === "classification" || raw === "size" || raw === "model") {
      return raw;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function loadSavedGroupByBranch(): boolean {
  try {
    return localStorage.getItem(GROUP_BY_BRANCH_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadSavedFilter(): CatalogFilterValue | null {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CatalogFilterValue>;
    if (
      typeof parsed?.from === "string" &&
      typeof parsed?.through === "string" &&
      parsed.items &&
      parsed.branches &&
      parsed.stores
    ) {
      return parsed as CatalogFilterValue;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function saveFilter(next: CatalogFilterValue, applied?: boolean) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(next));
    if (applied !== undefined) {
      localStorage.setItem(APPLIED_STORAGE_KEY, applied ? "1" : "0");
    }
  } catch {
    // Ignore storage errors
  }
}

function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string>();
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string>();

  const [value, setValue] = useState<CatalogFilterValue>(() => loadSavedFilter() ?? defaultFilterValue());
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const [report, setReport] = useState<ItemPerformanceReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string>();
  const [activeTab, setActiveTab] = useState<"items" | "branches">("items");
  const [activePage, setActivePage] = useState<"performance" | "transfers">(() =>
    window.location.pathname.startsWith("/reports/transfers") ? "transfers" : "performance",
  );
  const [groupBy, setGroupBy] = useState<GroupByLevel | null>(() => loadSavedGroupBy());
  const [groupByBranch, setGroupByBranch] = useState<boolean>(() => loadSavedGroupByBranch());
  const [filterOpen, setFilterOpen] = useState(() => {
    try {
      return localStorage.getItem(APPLIED_STORAGE_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const reportAbortRef = useRef<AbortController | null>(null);

  const [selectedRow, setSelectedRow] = useState<ItemPerformanceRow | null>(null);
  const [selectedGroupRow, setSelectedGroupRow] = useState<DisplayPerformanceRow | null>(null);
  const [productCardTarget, setProductCardTarget] = useState<ProductCardTarget | null>(null);
  const [ledger, setLedger] = useState<ItemLedgerReport | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string>();
  const ledgerAbortRef = useRef<AbortController | null>(null);

  const clearSensitiveState = () => {
    reportAbortRef.current?.abort();
    ledgerAbortRef.current?.abort();
    setCatalog(null);
    setReport(null);
    setLedger(null);
    setSelectedRow(null);
    setSelectedGroupRow(null);
    setProductCardTarget(null);
    setReportError(undefined);
    setLedgerError(undefined);
    setError(undefined);
  };

  const handleUnauthorized = (message?: string) => {
    clearSensitiveState();
    setSession({
      authenticated: false,
      username: null,
      displayName: null,
    });
    if (message) setLoginError(message);
  };

  useEffect(() => {
    const controller = new AbortController();
    setSessionLoading(true);
    setSessionError(undefined);
    fetchSession(controller.signal)
      .then(data => {
        if (!controller.signal.aborted) setSession(data);
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          setSessionError(reason instanceof Error ? reason.message : "تعذر التحقق من الجلسة.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSessionLoading(false);
      });
    return () => controller.abort();
  }, []);

  const runReport = (
    filterValue: CatalogFilterValue,
    catalogIndex: ReturnType<typeof buildCatalogIndex>,
    catalogLocations: CatalogResponse["locations"],
  ) => {
    reportAbortRef.current?.abort();
    const controller = new AbortController();
    reportAbortRef.current = controller;

    const allItemsSelected = filterValue.items.mode === "all" && filterValue.items.excludeIds.length === 0;
    const productIds = allItemsSelected
      ? null
      : selectedLeaves(catalogIndex, filterValue.items).map(n => n.code ?? n.id.replace(/^product:/, ""));
    const branchIds = filterValue.branches.mode === "all" ? null : selectedLocationIds(catalogLocations, filterValue.branches);
    const storeKeys = filterValue.stores.mode === "all" ? null : filterValue.stores.ids;

    setReportLoading(true);
    setReportError(undefined);
    setSelectedGroupRow(null);
    saveFilter(filterValue, true);

    fetchItemPerformance(
      {
        from: filterValue.from,
        to: filterValue.through,
        productIds,
        branchIds,
        storeKeys,
      },
      controller.signal,
    )
      .then(data => {
        if (!controller.signal.aborted) {
          setReport(data);
          setFilterOpen(false);
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          if (reason instanceof UnauthorizedError) {
            handleUnauthorized(reason.message);
            return;
          }
          setReportError(reason instanceof Error ? reason.message : "تعذر تشغيل التقرير");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setReportLoading(false);
      });
  };

  useEffect(() => {
    if (!session?.authenticated) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    fetchFilterOptions(controller.signal)
      .then(data => {
        const builtIndex = buildCatalogIndex(data.nodes);
        if (!Array.isArray(data.locations) || !data.source?.label || !Number.isFinite(Date.parse(data.source.readAt))) {
          throw new Error("بيانات المصدر غير صالحة.");
        }
        if (!controller.signal.aborted) {
          setCatalog(data);
          const saved = loadSavedFilter();
          const validSaved = saved && !validateFilter(saved, builtIndex, data.locations) ? saved : null;
          const activeFilter = validSaved ?? defaultFilterValue();
          setValue(activeFilter);
          if (validSaved && localStorage.getItem(APPLIED_STORAGE_KEY) === "1") {
            runReport(activeFilter, builtIndex, data.locations);
          }
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          if (reason instanceof UnauthorizedError) {
            handleUnauthorized(reason.message);
            return;
          }
          setError(reason instanceof Error ? reason.message : "تعذر تحميل البيانات");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt, session?.authenticated]);

  const handleSelectRow = (row: ItemPerformanceRow) => {
    if (!report) return;
    ledgerAbortRef.current?.abort();
    const controller = new AbortController();
    ledgerAbortRef.current = controller;

    setSelectedRow(row);
    setLedger(null);
    setLedgerLoading(true);
    setLedgerError(undefined);

    fetchItemLedger(
      {
        baseline: report.meta.baseline,
        from: report.meta.from,
        to: report.meta.to,
        branchId: row.branchId,
        storeId: row.storeId,
        productId: row.productId,
      },
      controller.signal,
    )
      .then(data => {
        if (!controller.signal.aborted) setLedger(data);
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          if (reason instanceof UnauthorizedError) {
            handleUnauthorized(reason.message);
            return;
          }
          setLedgerError(reason instanceof Error ? reason.message : "تعذر تحميل كارت الصنف");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLedgerLoading(false);
      });
  };

  const handleCloseLedger = () => {
    ledgerAbortRef.current?.abort();
    setSelectedRow(null);
    setLedger(null);
    setLedgerError(undefined);
    setLedgerLoading(false);
  };

  useEffect(() => {
    if (!filterOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterOpen]);

  const nodes = catalog?.nodes ?? [];
  const locations = catalog?.locations ?? [];
  const index = useMemo(() => buildCatalogIndex(nodes), [nodes]);
  const selectedItemCount = selectedLeaves(index, value.items).length;
  const selectedBranchCount = selectedLocationIds(locations, value.branches).length;

  const handleApply = () => {
    runReport(value, index, locations);
  };

  const handleFilterChange = (next: CatalogFilterValue) => {
    setValue(next);
    saveFilter(next);
  };

  const handleGroupByChange = (next: GroupByLevel | null) => {
    setGroupBy(next);
    setSelectedGroupRow(null);
    if (next) handleCloseLedger();
    try {
      if (next) localStorage.setItem(GROUP_BY_STORAGE_KEY, next);
      else localStorage.removeItem(GROUP_BY_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  };

  const handleGroupByBranchChange = (next: boolean) => {
    setGroupByBranch(next);
    setSelectedGroupRow(null);
    if (next) handleCloseLedger();
    try {
      if (next) localStorage.setItem(GROUP_BY_BRANCH_STORAGE_KEY, "1");
      else localStorage.removeItem(GROUP_BY_BRANCH_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  };

  const handleSelectBranchFromComparison = (branchId: string) => {
    const nextFilter = changeBranches(value, { mode: "selected", ids: [branchId] }, locations);
    setValue(nextFilter);
    setActiveTab("items");
    runReport(nextFilter, index, locations);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginSubmitting(true);
    setLoginError(undefined);
    try {
      await loginReports(loginUsername.trim(), loginPassword);
      const nextSession = await fetchSession();
      setSession(nextSession);
      setLoginPassword("");
    } catch (reason) {
      setLoginError(reason instanceof Error ? reason.message : "تعذر تسجيل الدخول.");
    } finally {
      setLoginSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logoutReports();
    } catch {
      // Ignore network errors on logout and wipe local state anyway
    }
    handleUnauthorized();
  };

  useEffect(() => {
    const onPopState = () => {
      setActivePage(window.location.pathname.startsWith("/reports/transfers") ? "transfers" : "performance");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigatePage = (e: React.MouseEvent<HTMLAnchorElement>, page: "performance" | "transfers", href: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (window.location.pathname !== href) {
      window.history.pushState(null, "", href);
    }
    setActivePage(page);
  };

  return (
    <div className="rf-app" dir="rtl">
      <header className="rf-topbar">
        <div className="rf-topbar-inner">
          <div className="rf-topbar-start">
            <a
              className="rf-brand"
              href="/reports/"
              aria-label="EMOJI Store"
              onClick={e => navigatePage(e, "performance", "/reports/")}
            >
              <img src={`${import.meta.env.BASE_URL}emoji-logo.png`} alt="EMOJI Store" />
            </a>
            {session?.authenticated && (
              <nav className="rf-nav" aria-label="صفحات التقارير">
                <a
                  href="/reports/"
                  className={`rf-nav-link ${activePage === "performance" ? "is-active" : ""}`}
                  onClick={e => navigatePage(e, "performance", "/reports/")}
                >
                  أداء الأصناف
                </a>
                <a
                  href="/reports/transfers"
                  className={`rf-nav-link ${activePage === "transfers" ? "is-active" : ""}`}
                  onClick={e => navigatePage(e, "transfers", "/reports/transfers")}
                >
                  إعادة توزيع المخزون
                </a>
              </nav>
            )}
          </div>
          <div className="rf-topbar-actions">
            <span>
              {session?.authenticated && (session.displayName || session.username)
                ? session.displayName || session.username
                : "تقارير الإدارة · أداء الأصناف"}
            </span>
            {session?.authenticated && (
              <button type="button" className="rf-logout-btn" onClick={handleLogout}>
                تسجيل الخروج
              </button>
            )}
          </div>
        </div>
      </header>

      {sessionLoading ? (
        <main className="rf-main">
          <div className="rf-report-loading">جارٍ التحقق من الصلاحية…</div>
        </main>
      ) : sessionError ? (
        <main className="rf-main">
          <div className="rf-report-error" role="alert">{sessionError}</div>
        </main>
      ) : !session?.authenticated ? (
        <main className="rf-auth-wrap">
          <form className="rf-auth-card" onSubmit={handleLoginSubmit}>
            <h1>تسجيل الدخول للتقارير</h1>
            <p>هذه البيانات خاصة بالإدارة. سجّل الدخول بحساب التقارير الخاص بك.</p>
            {loginError && <div className="rf-auth-error" role="alert">{loginError}</div>}
            <label className="rf-auth-field">
              اسم المستخدم
              <input
                type="text"
                autoComplete="username"
                required
                minLength={3}
                value={loginUsername}
                onChange={e => setLoginUsername(e.target.value)}
              />
            </label>
            <label className="rf-auth-field">
              كلمة المرور
              <input
                type="password"
                autoComplete="current-password"
                required
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
              />
            </label>
            <button type="submit" className="rf-auth-submit" disabled={loginSubmitting}>
              {loginSubmitting ? "جارٍ التحقق…" : "دخول"}
            </button>
          </form>
        </main>
      ) : (
      <>
      <main className="rf-main">
        <div className={`rf-source ${error ? "is-error" : ""}`}>
          <strong>
            {loading ? "جارٍ تحميل البيانات…" : error ? "تعذر تحديث المصدر" : ""}
          </strong>
          {catalog && (
            <span>
              {error ? "آخر قراءة سابقة: " : "قراءة: "}
              {new Intl.DateTimeFormat("ar-EG-u-nu-latn", { dateStyle: "short", timeStyle: "short" }).format(
                new Date(catalog.source.readAt),
              )}
            </span>
          )}
        </div>

        {activePage === "transfers" ? (
          <StockTransfersPage
            report={report}
            reportLoading={reportLoading}
            reportError={reportError}
            locations={locations}
            from={value.from}
            through={value.through}
            onRunReport={() => runReport(value, index, locations)}
            onOpenFilter={() => setFilterOpen(true)}
            onInspectProduct={setProductCardTarget}
          />
        ) : (
        <>
        <div className="rf-filter-toggle-bar">
          <div>
            {report ? (
              <>
                <strong>نطاق التقرير:</strong>{" "}
                <span>
                  {report.meta.from} إلى {report.meta.to} · {selectedItemCount} صنف · {selectedBranchCount} فروع
                  {groupBy ? ` · تجميع: ${GROUP_BY_LABELS[groupBy]}` : ""}
                  {groupByBranch ? " · تجميع الفروع" : ""}
                </span>
              </>
            ) : (
              <>
                <strong>الفلاتر:</strong>{" "}
                <span>{selectedItemCount} صنف · {selectedBranchCount} فروع</span>
              </>
            )}
          </div>
          <button type="button" className="ip-btn-outline" onClick={() => setFilterOpen(true)}>
            <span>تغيير الفلاتر</span>
          </button>
        </div>

        <div className="rf-content">
          {reportLoading && <div className="rf-report-loading">جارٍ حساب تقرير أداء الأصناف…</div>}

          {reportError && (
            <div className="rf-report-error" role="alert">
              {reportError}
            </div>
          )}

          {!report && !reportLoading && !reportError && (
            <div className="rf-report-placeholder">
              <p>اختر الفترة والأصناف والفروع ثم اضغط تطبيق الفلاتر لعرض التقرير.</p>
              <button type="button" className="ip-btn-outline" onClick={() => setFilterOpen(true)}>
                <span>فتح الفلاتر</span>
              </button>
            </div>
          )}

          {report && !reportLoading && (
            <>
              <ItemPerformanceSummaryCards
                summary={report.summary}
                from={report.meta.from}
                to={report.meta.to}
                periodDays={report.meta.periodDays}
              />
              <div className="ip-tabs" role="tablist" aria-label="نوع العرض">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "items"}
                  className={`ip-tab ${activeTab === "items" ? "is-active" : ""}`}
                  onClick={() => setActiveTab("items")}
                >
                  <span>أداء الأصناف</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "branches"}
                  className={`ip-tab ${activeTab === "branches" ? "is-active" : ""}`}
                  onClick={() => setActiveTab("branches")}
                >
                  <span>مقارنة الفروع</span>
                </button>
              </div>
              {activeTab === "items" ? (
                <ItemPerformanceTable
                  rows={report.rows}
                  from={report.meta.from}
                  to={report.meta.to}
                  groupBy={groupBy}
                  groupByBranch={groupByBranch}
                  onClearGroupBy={() => handleGroupByChange(null)}
                  onClearGroupByBranch={() => handleGroupByBranchChange(false)}
                  onSelectRow={handleSelectRow}
                  onSelectGroup={setSelectedGroupRow}
                  onInspectProduct={setProductCardTarget}
                />
              ) : (
                <BranchComparisonTable
                  rows={report.rows}
                  from={report.meta.from}
                  to={report.meta.to}
                  onSelectBranch={handleSelectBranchFromComparison}
                />
              )}
            </>
          )}
        </div>
        </>
        )}
      </main>

      <button
        type="button"
        className="rf-fab"
        onClick={() => setFilterOpen(v => !v)}
        aria-expanded={filterOpen}
        aria-label="فتح أو إغلاق الفلاتر"
        title="الفلاتر"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16" y2="16" />
        </svg>
      </button>

      {filterOpen && (
        <div
          className="rf-drawer-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="فلاتر التقرير"
          onClick={e => {
            if (e.target === e.currentTarget) setFilterOpen(false);
          }}
        >
          <aside className="rf-drawer">
            <div className="rf-drawer-header">
              <strong>
                <span>فلاتر التقرير</span>
              </strong>
              <button
                type="button"
                className="rf-drawer-close"
                onClick={() => setFilterOpen(false)}
                aria-label="إغلاق الفلاتر"
              >
                ×
              </button>
            </div>
            <div className="rf-drawer-body">
              <CatalogFilter
                nodes={nodes}
                locations={locations}
                value={value}
                onChange={handleFilterChange}
                onApply={handleApply}
                groupBy={groupBy}
                onGroupByChange={handleGroupByChange}
                groupByBranch={groupByBranch}
                onGroupByBranchChange={handleGroupByBranchChange}
                loading={loading || reportLoading}
                error={error}
                onRetry={() => setAttempt(v => v + 1)}
              />
            </div>
          </aside>
        </div>
      )}
      <GroupDetailsDrawer
        groupRow={selectedGroupRow}
        groupBy={groupBy}
        suppressEscape={Boolean(selectedRow || productCardTarget)}
        onClose={() => setSelectedGroupRow(null)}
        onSelectItem={handleSelectRow}
        onInspectProduct={setProductCardTarget}
      />
      <ItemLedgerDrawer
        selectedRow={selectedRow}
        ledger={ledger}
        loading={ledgerLoading}
        error={ledgerError}
        onClose={handleCloseLedger}
      />
      <ProductCardModal
        target={productCardTarget}
        reportRows={report?.rows ?? []}
        onClose={() => setProductCardTarget(null)}
        onUnauthorized={handleUnauthorized}
      />
      </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
