import { type ReactNode, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldCheck,
  TriangleAlert,
  LoaderCircle,
} from "lucide-react";
import { api, post, number, dateTime } from "./api";
import {
  membershipLabels,
  whatsappLabels,
} from "../../../packages/domain/contracts";

export function Button({
  children,
  busy = false,
  kind = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  kind?: string;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={`button ${kind} ${props.className ?? ""}`}
    >
      {busy ? <LoaderCircle className="spin" size={16} /> : null}
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  title,
  description,
  badgeActive = "مفعّلة",
  badgeInactive = "متوقفة",
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title: string;
  description?: string;
  badgeActive?: string;
  badgeInactive?: string;
  id?: string;
}) {
  return (
    <div
      className={`toggle-switch-card ${checked ? "active" : ""}`}
      onClick={(e) => {
        if (!disabled && (e.target as HTMLElement).tagName !== "BUTTON") {
          onChange(!checked);
        }
      }}
    >
      <div className="toggle-switch-info">
        <span className="toggle-switch-title">{title}</span>
        {description && <span className="toggle-switch-desc">{description}</span>}
      </div>
      <div className="toggle-switch-action" onClick={(e) => e.stopPropagation()}>
        <span
          className={`toggle-badge ${checked ? "active" : "inactive"}`}
          onClick={() => !disabled && onChange(!checked)}
        >
          <i className="toggle-dot" />
          <span>{checked ? badgeActive : badgeInactive}</span>
        </span>
        <button
          type="button"
          role="switch"
          dir="ltr"
          id={id}
          aria-checked={checked}
          disabled={disabled}
          className={`toggle-switch-btn ${checked ? "checked" : ""}`}
          onClick={() => !disabled && onChange(!checked)}
          title={checked ? badgeActive : badgeInactive}
        >
          <span className="toggle-switch-slider" />
        </button>
      </div>
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div className={`notice ${tone}`}>
      {tone === "error" ? (
        <TriangleAlert size={16} />
      ) : (
        <ShieldCheck size={16} />
      )}
      <div>{children}</div>
    </div>
  );
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <i />
      {children}
    </span>
  );
}
export function CustomerTable({
  report,
  canCheck,
  onChecked,
  notify,
}: {
  report: any;
  canCheck: boolean;
  onChecked: () => void;
  notify: (s: string, error?: boolean) => void;
}) {
  const [checking, setChecking] = useState("");
  async function check(row: any) {
    const key = `${row.branch_id}:${row.person_id}`;
    setChecking(key);
    try {
      await post("/customers/check", {
        programId: row.program_id,
        branchId: row.branch_id,
        personId: row.person_id,
      });
      onChecked();
      notify("تم تحديث نتيجة فحص واتساب.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setChecking("");
    }
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>العميل والفرع</th>
            <th>رقم الموبايل</th>
            <th>صلاحية الرقم</th>
            <th>واتساب</th>
            <th>الانضمام للجروب</th>
            <th>الفحص</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row: any) => (
            <tr key={`${row.program_id}:${row.branch_id}:${row.person_id}`}>
              <td>
                <strong>{row.name || "بدون اسم"}</strong>
                <small>{row.branch_name ?? row.branch_id}</small>
              </td>
              <td>
                <span className="phone" dir="ltr">
                  {row.raw_phone || "—"}
                </span>
                <small>
                  {row.is_baseline ? "من أول مزامنة" : dateTime(row.first_seen)}
                </small>
              </td>
              <td title={row.phone_reason}>
                <Badge
                  tone={
                    row.phone_state === "valid"
                      ? "green"
                      : row.phone_state === "missing"
                        ? "muted"
                        : "red"
                  }
                >
                  {
                    {
                      valid: "مصري صحيح",
                      missing: "غير مسجل",
                      invalid: "غير صالح",
                      not_egyptian: "ليس رقمًا مصريًا",
                    }[row.phone_state as string]
                  }
                </Badge>
              </td>
              <td>
                <Badge
                  tone={
                    row.whatsapp_state === "registered"
                      ? "green"
                      : row.whatsapp_state === "not_registered"
                        ? "red"
                        : "muted"
                  }
                >
                  {whatsappLabels[row.whatsapp_state] ?? row.whatsapp_state}
                </Badge>
              </td>
              <td>
                <span className="membership-label">
                  {membershipLabels[row.membership_state] ??
                    row.membership_state}
                </span>
                {(row.source_active === 0 || row.branch_source_active === 0) && <small>لم يعد نشطًا في المصدر</small>}
              </td>
              <td>
                <button
                  className="text-button"
                  disabled={
                    !canCheck ||
                    row.phone_state !== "valid" ||
                    Boolean(checking)
                  }
                  title={
                    !canCheck
                      ? "اربط واتساب من شاشة الاتصال أولًا"
                      : "فحص واتساب وتسوية العضوية السابقة دون إرسال"
                  }
                  onClick={() => void check(row)}
                >
                  {checking === `${row.branch_id}:${row.person_id}`
                    ? "جارٍ الفحص…"
                    : "فحص الحالة"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!report.rows.length && (
        <Empty
          title="لا توجد أرقام في هذا العرض"
          detail="غيّر التاريخ أو الفلاتر، أو تأكد من ربط قاعدة البيانات."
        />
      )}
    </div>
  );
}
export function ReportView({
  company,
  isDaily,
  notify,
}: {
  company: any;
  isDaily: boolean;
  notify: (s: string, error?: boolean) => void;
}) {
  const [scope, setScope] = useState(isDaily ? "daily" : "all"),
    [day, setDay] = useState(company.today),
    [branch, setBranch] = useState(""),
    [search, setSearch] = useState(""),
    [state, setState] = useState("all"),
    [page, setPage] = useState(1);
  const [report, setReport] = useState<any>(null),
    [branches, setBranches] = useState<any[]>([]),
    [loading, setLoading] = useState(true);
  const query = new URLSearchParams({
    scope,
    date: day,
    state,
    page: String(page),
    ...(branch ? { branch } : {}),
    ...(search ? { search } : {}),
  }).toString();
  const load = async () => {
    setLoading(true);
    try {
      const [rows, list] = await Promise.all([
        api("/customers?" + query),
        api("/branches"),
      ]);
      setReport(rows);
      setBranches(list);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  };
  React.useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      void api("/customers?" + query).then((rows) => {
        if (active) setReport(rows);
      }).catch((e) => { if (active) notify(e.message, true); });
    }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [query, company.id]);
  // Request cancellation prevents a slower old filter response from replacing the current view.
  React.useEffect(() => {
    let live = true;
    setLoading(true);
    const timeout = setTimeout(() => {
      void Promise.all([api("/customers?" + query), api("/branches")])
        .then(([rows, list]) => {
          if (live) {
            setReport(rows);
            setBranches(list);
          }
        })
        .catch((e) => {
          if (live) notify(e.message, true);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, [query, company.id]);
  return (
    <>
      <div className="page-heading">
        <h1>{isDaily ? "التقرير اليومي" : "العملاء"}</h1>
        <a className="button secondary" href={"/api/reports.csv?" + query}>
          <ArrowDownToLine size={17} />
          تصدير CSV
        </a>
      </div>
      {isDaily && (
        <Notice>
          التاريخ هنا هو يوم اكتشاف البرنامج للعميل، وليس تاريخ تسجيله في الفرع.
          العملاء الموجودون من أول مزامنة يظهرون في السجل الكامل.
        </Notice>
      )}
      <div className="stat-strip">
        {[
          ["إجمالي الأرقام", "total"],
          ["موبايل مصري صحيح", "valid"],
          ["غير صالح أو غير مسجل", "invalid"],
          ["صحيح بدون واتساب", "not_registered"],
          ["انضم للجروب", "joined"],
        ].map(([label, key]) => (
          <div key={key}>
            <span>{label}</span>
            <strong>{number(report?.totals[key])}</strong>
          </div>
        ))}
      </div>
      <section className="panel">
        <div className="filters">
          <div className="search">
            <Search size={17} />
            <input
              aria-label="ابحث بالاسم أو الرقم"
              placeholder="ابحث بالاسم أو الرقم"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <select
            aria-label="الفرع"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setPage(1);
            }}
          >
            <option value="">كل الفروع</option>
            {branches.map((b) => (
              <option value={b.branch_id} key={b.branch_id}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            aria-label="الحالة"
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">كل الحالات</option>
            <option value="valid">رقم مصري صحيح</option>
            <option value="invalid">غير صالح أو غير مسجل</option>
            <option value="not_registered">بدون واتساب</option>
            <option value="joined">انضم للجروب</option>
            <option value="unchecked">صحيح ولم يُفحص</option>
          </select>
          {isDaily && (
            <input
              aria-label="تاريخ التقرير"
              type="date"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                setPage(1);
              }}
            />
          )}
        </div>
        <div className="table-heading">
          <h3>
            {scope === "all"
              ? "جميع الأرقام المسجلة"
              : "الأرقام المكتشفة في اليوم المحدد"}{" "}
            <span>{number(report?.totals.total)}</span>
          </h3>
          {isDaily && (
            <button
              className="text-button"
              onClick={() => {
                setScope(scope === "all" ? "daily" : "all");
                setPage(1);
              }}
            >
              {scope === "all" ? "العودة للتقرير اليومي" : "عرض السجل الكامل"}
            </button>
          )}
        </div>
        {loading && !report ? (
          <div className="loading">
            <LoaderCircle className="spin" />
            تحميل الأرقام…
          </div>
        ) : (
          report && (
            <CustomerTable
              report={report}
              canCheck={company.whatsapp.status === "ready"}
              onChecked={() => void load()}
              notify={notify}
            />
          )
        )}
        <div className="pagination">
          <span>
            صفحة {number(page)} · {number(report?.totals.total)} سجل
          </span>
          <div>
            <button
              aria-label="الصفحة السابقة"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronRight size={17} />
            </button>
            <button
              aria-label="الصفحة التالية"
              disabled={page * 50 >= (report?.totals.total ?? 0)}
              onClick={() => setPage(page + 1)}
            >
              <ChevronLeft size={17} />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
import * as React from "react";
