import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Building2,
    FileChartColumn,
  LayoutDashboard,
  LogOut,
  Plus,
  Settings2,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { api, post } from "./api";
import { Button, Field, Notice, ReportView } from "./components";
import {
  CompanySetup,
  Overview,
  Branches,
  Settings,
} from "./views";
import "./styles.css";

const pages = [
  { id: "overview", label: "نظرة عامة", icon: LayoutDashboard },
  { id: "customers", label: "العملاء", icon: Users },
  { id: "branches", label: "الفروع والجروبات", icon: Building2 },
  { id: "reports", label: "التقرير اليومي", icon: FileChartColumn },
  { id: "connections", label: "الاتصالات", icon: Wifi },
  { id: "settings", label: "الإعدادات", icon: Settings2 },
];
function Auth({
  bootstrap,
  onDone,
}: {
  bootstrap: boolean;
  onDone: () => Promise<void>;
}) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(bootstrap ? "/auth/bootstrap" : "/auth/login", {
        username,
        password,
      });
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <h1>{bootstrap ? "إنشاء حساب المسؤول" : "تسجيل الدخول"}</h1>
      <form className="auth-form" onSubmit={submit}>
        <Field label="اسم المستخدم">
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={80}
          />
        </Field>
        <Field
          label="كلمة المرور"
          hint={bootstrap ? "10 أحرف على الأقل" : undefined}
        >
          <input
            type="password"
            autoComplete={bootstrap ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={bootstrap ? 10 : undefined}
            required
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button busy={busy}>{bootstrap ? "إنشاء الحساب" : "دخول"}</Button>
      </form>
    </main>
  );
}
function App() {
  const [session, setSession] = useState<any>(null),
    [company, setCompany] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("overview"),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(
      null,
    ),
    [fatal, setFatal] = useState(""),
    [addingCompany, setAddingCompany] = useState(false);
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  const refresh = useCallback(async () => {
    try {
      const next = await api("/session");
      let details = null;
      if (next.authenticated && next.companyId) {
        try {
          details = await api("/company");
          if (details?.name) {
            document.title = details.name + " | إدارة العملاء";
          }
        } catch (err) {
          console.error("Failed to fetch company details:", err);
        }
      }
      // Update session and company together to prevent flashing registration view on refresh
      setSession(next);
      setCompany(details);
    } catch (e) {
      setFatal((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!company) return;
    const timer = setInterval(() => {
      void api("/company")
        .then((next) =>
          setCompany((current: any) =>
            current?.id === next.id ? next : current,
          ),
        )
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [company?.id]);
  async function switchCompany(id: string) {
    try {
      setLoading(true);
      await post("/company/switch", { id });
      setPage("overview");
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
      setLoading(false);
    }
  }
  if (fatal)
    return (
      <main className="auth-page">
        <Notice tone="error">{fatal}</Notice>
        <Button onClick={() => location.reload()}>إعادة المحاولة</Button>
      </main>
    );
  if (loading || !session)
    return (
      <div className="boot">
        <span className="boot-dot" />
        تحميل مساحة العمل…
      </div>
    );
  if (!session.authenticated)
    return (
      <>
        <Auth bootstrap={session.setupRequired} onDone={refresh} />
        {toast && (
          <div
            role="status"
            className={"toast " + (toast.error ? "error" : "")}
          >
            {toast.message}
            <button aria-label="إغلاق" onClick={() => setToast(null)}>
              <X size={16} />
            </button>
          </div>
        )}
      </>
    );
  if (!session.companyId)
    return (
      <>
        <CompanySetup onDone={refresh} notify={notify} />
        {toast && (
          <div
            role="status"
            className={"toast " + (toast.error ? "error" : "")}
          >
            {toast.message}
            <button aria-label="إغلاق" onClick={() => setToast(null)}>
              <X size={16} />
            </button>
          </div>
        )}
      </>
    );
  if (!company)
    return (
      <div className="boot">
        <span className="boot-dot" />
        تحميل بيانات الشركة…
      </div>
    );
  const props = { company, refresh, notify };
  const whatsappReady = company.whatsapp.status === "ready";
  const databaseReady = Boolean(company.source) && !company.source.last_error;
  const activeServices=Object.values(company.workers??{}).filter(Boolean).length;
  const running = activeServices>0;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          {company.has_logo ? (
            <img
              className="brand-logo"
              src={"/api/company/logo?v=" + company.name}
              alt={"شعار " + company.name}
            />
          ) : (
            <div className="brand-monogram">{company.name?.slice(0, 1) || "ش"}</div>
          )}
          <strong>{company.name}</strong>
        </div>
        <nav>
          {pages.map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              title={item.label}
              className={page === item.id && !addingCompany ? "active" : ""}
              onClick={() => {
                setPage(item.id);
                setAddingCompany(false);
              }}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="link-status" onClick={() => setPage("connections")}>
            <span>
              <i className={"dot " + (databaseReady ? "green" : "gray")} />
              قاعدة البيانات
            </span>
            <span>
              <i className={"dot " + (whatsappReady ? "green" : "gray")} />
              واتساب
            </span>
          </button>
          {(session.companies || []).length > 1 && (
            <label className="company-switch">
              <Building2 size={16} />
              <select
                aria-label="تبديل الشركة"
                value={company.id}
                onChange={(e) => void switchCompany(e.target.value)}
              >
                {(session.companies || []).map((c: any) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="sidebar-actions">
            <button
              onClick={() => {
                setAddingCompany(true);
                setPage("overview");
              }}
            >
              <Plus size={15} />
              شركة جديدة
            </button>
            <button onClick={() => void post("/logout").then(refresh)}>
              <LogOut size={15} />
              خروج
            </button>
          </div>
          <span className="sidebar-version">v{import.meta.env.VITE_APP_VERSION}</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className={"run-state " + (running && whatsappReady ? "live" : "idle")}><i/><div><strong>{running?"الخدمات مفعلة":"الخدمات متوقفة"}</strong><span>{running?whatsappReady?"تابع حالة كل خدمة من الإعدادات.":"بانتظار اتصال واتساب لاستكمال الخدمات.":"اختار الخدمة المطلوبة وشغّلها من الإعدادات."}</span></div></div>
          <button type="button" className="text-button" onClick={()=>setPage("settings")}><Settings2 size={16}/>إعدادات الخدمات</button>
        </header>
        <main className="main-content">
          {addingCompany ? (
            <>
              <button
                className="text-button back"
                onClick={() => setAddingCompany(false)}
              >
                العودة لمساحة الشركة
              </button>
              <CompanySetup
                isNew
                notify={notify}
                onDone={async () => {
                  setAddingCompany(false);
                  await refresh();
                }}
              />
            </>
          ) : page === "overview" ? (
            <Overview {...props} navigate={setPage} />
          ) : page === "customers" || page === "reports" ? (
            <ReportView
              key={company.id + page}
              company={company}
              isDaily={page === "reports"}
              notify={notify}
            />
          ) : page === "branches" ? (
            <Branches key={company.id} {...props} />
          ) : page === "settings" ? (
            <Settings key={company.id} {...props} />
          ) : (
            <Settings key={company.id+"-connections"} {...props} initialTab="database" />
          )}
        </main>
      </div>
      {toast && (
        <div role="status" className={"toast " + (toast.error ? "error" : "")}>
          {toast.message}
          <button aria-label="إغلاق" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}

    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
