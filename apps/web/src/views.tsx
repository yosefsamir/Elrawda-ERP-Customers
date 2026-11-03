import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Database,
  ImagePlus,
  Link2,
  LoaderCircle,
  RefreshCw,
  Save,
  Wifi,
} from "lucide-react";
import { api, post, put, number, dateTime } from "./api";
import { Badge, Button, Empty, Field, Notice } from "./components";

type ViewProps = {
  company: any;
  refresh: () => Promise<void>;
  notify: (s: string, error?: boolean) => void;
};
export function CompanySetup({
  onDone,
  notify,
  isNew = false,
}: {
  onDone: () => Promise<void>;
  notify: ViewProps["notify"];
  isNew?: boolean;
}) {
  const [name, setName] = useState(""),
    [logo, setLogo] = useState<File | null>(null),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/companies", { name });
      if (logo) {
        const form = new FormData();
        form.append("logo", logo);
        await api("/company/logo", { method: "POST", body: form });
      }
      await onDone();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="setup-page">
      <h1>{isNew ? "شركة جديدة" : "بيانات الشركة"}</h1>
      <form className="setup-card" onSubmit={submit}>
        <Field label="اسم الشركة">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={100}
          />
        </Field>
        <Field label="شعار الشركة" hint="اختياري. PNG أو JPEG أو WebP حتى 2 ميجابايت.">
          <label className="upload-box">
            <ImagePlus size={20} />
            <span>{logo ? logo.name : "اختر صورة"}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
            />
          </label>
        </Field>
        <Button busy={busy}>حفظ ومتابعة</Button>
      </form>
    </div>
  );
}
export function SourceSetup({
  refresh,
  notify,
  onCancel,
}: Pick<ViewProps, "refresh" | "notify"> & { onCancel?: () => void }) {
  const [busy, setBusy] = useState(false),
    [databases, setDatabases] = useState<string[]>([]),
    [manualDb, setManualDb] = useState(false),
    [fetchingDbs, setFetchingDbs] = useState(false);
  const [form, setForm] = useState({
    server: "127.0.0.1",
    instance: "",
    database: "",
    user: "",
    password: "",
    encrypt: true,
    trustServerCertificate: true,
    programId: 9,
  });
  const change = (key: string, value: unknown) =>
    setForm({ ...form, [key]: value });

  async function fetchDatabases() {
    if (!form.password) {
      notify("اكتب كلمة مرور SQL أولًا لعرض قواعد البيانات المتاحة", true);
      return;
    }
    setFetchingDbs(true);
    try {
      const res = await post("/source/sql/databases", {
        server: form.server,
        instance: form.instance,
        user: form.user,
        password: form.password,
        encrypt: form.encrypt,
        trustServerCertificate: true,
      });
      setDatabases(res.databases);
      if (res.databases.length > 0) {
        const rawdaMatch = res.databases.find((d: string) =>
          d.toLowerCase().includes("rawda"),
        );
        const selected = rawdaMatch || res.databases[0];
        if (!form.database || !res.databases.includes(form.database)) {
          change("database", selected);
        }
        notify(`تم الاتصال بنجاح. اختر قاعدة البيانات من القائمة (${res.databases.length} قاعدة متاحة).`);
      } else {
        notify("تم الاتصال بنجاح ولكن لم يتم العثور على قواعد بيانات مستخدمين إضافية.", true);
      }
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setFetchingDbs(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.database) {
      notify("اختر أو اكتب اسم قاعدة البيانات أولاً للمتابعة", true);
      return;
    }
    setBusy(true);
    try {
      const result = await post("/source/sql", form);
      notify(
        `اكتملت المزامنة بنجاح: تم جلب ${number(result.added)} سجل كقاعدة أساسية (Baseline).`,
      );
      await refresh();
      onCancel?.();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="source-form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="اسم أو عنوان السيرفر">
            <input
              dir="ltr"
              placeholder="localhost أو 127.0.0.1"
              value={form.server}
              onChange={(e) => change("server", e.target.value)}
              required
            />
          </Field>
          <Field
            label="اسم الـ Instance"
            hint="اتركه فارغاً إذا كنت تتصل بالمنفذ الافتراضي 1433"
          >
            <input
              dir="ltr"
              placeholder="اختياري"
              value={form.instance}
              onChange={(e) => change("instance", e.target.value)}
            />
          </Field>
          <Field label="اسم مستخدم SQL">
            <input
              dir="ltr"
              value={form.user}
              onChange={(e) => change("user", e.target.value)}
              required
            />
          </Field>
          <Field label="كلمة المرور">
            <input
              dir="ltr"
              type="password"
              placeholder="كلمة مرور حساب SQL المخصص للقراءة"
              value={form.password}
              onChange={(e) => change("password", e.target.value)}
              required
              autoComplete="new-password"
            />
          </Field>
        </div>

          <Field
            label="قاعدة البيانات"
            hint={
              databases.length > 0
                ? `تم العثور على ${databases.length} قاعدة بيانات في السيرفر`
                : "اكتب كلمة المرور واضغط زر جلب القواعد لعرض القائمة المتاحة"
            }
          >
            {!manualDb ? (
              <div className="input-with-action">
                <select
                  dir="ltr"
                  value={form.database}
                  onChange={(e) => change("database", e.target.value)}
                  required
                >
                  <option value="">
                    {databases.length > 0
                      ? "-- اختر قاعدة البيانات من القائمة --"
                      : "-- اضغط زر جلب القواعد لعرض القائمة --"}
                  </option>
                  {databases.map((db) => (
                    <option key={db} value={db}>
                      {db}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  kind="secondary"
                  busy={fetchingDbs}
                  onClick={() => void fetchDatabases()}
                  title="جلب أو تحديث قائمة قواعد البيانات"
                >
                  <RefreshCw size={14} />
                  {databases.length > 0 ? "تحديث القائمة" : "جلب القواعد"}
                </Button>
              </div>
            ) : (
              <div className="input-with-action">
                <input
                  dir="ltr"
                  placeholder="اسم قاعدة البيانات (مثال: ElRawda)"
                  value={form.database}
                  onChange={(e) => change("database", e.target.value)}
                  required
                />
              </div>
            )}
            <button type="button" className="text-button" onClick={() => setManualDb(!manualDb)}>
              {!manualDb ? "كتابة الاسم يدويًا" : "الرجوع للقائمة"}
            </button>
          </Field>

        <details className="setup-advanced">
          <summary>إعدادات متقدمة</summary>
          <Field label="رقم البرنامج داخل ERP" hint="القيمة الافتراضية 9. لا تغيّرها إلا عند الحاجة.">
            <input
              type="number"
              min={1}
              value={form.programId}
              onChange={(e) => change("programId", Number(e.target.value))}
            />
          </Field>
        </details>

        <div className="connection-actions">
          <Button busy={busy}>حفظ وبدء المزامنة</Button>
          {onCancel && (
            <Button type="button" kind="secondary" onClick={onCancel}>
              إلغاء
            </Button>
          )}
        </div>
    </form>
  );
}
export function Overview({
  company,
  notify,
  navigate,
}: ViewProps & { navigate: (page: string) => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let live = true;
    void api("/overview")
      .then((result) => {
        if (live) setData(result);
      })
      .catch((e) => notify(e.message, true));
    return () => {
      live = false;
    };
  }, [company.id, company.source?.last_sync]);
  if (!data)
    return (
      <div className="loading">
        <LoaderCircle className="spin" />
        تحميل لوحة المتابعة…
      </div>
    );
  const active = data.branches.filter((b: any) => b.enabled),
    max = Math.max(1, ...active.map((b: any) => b.total));
  const whatsappReady = company.whatsapp.status === "ready";
  const steps = [
    {
      label: "قاعدة البيانات",
      done: Boolean(company.source) && !company.source.last_error,
      detail: !company.source
        ? "غير مربوطة. لن تظهر بيانات عملاء قبل ربطها."
        : company.source.last_error
        ? "تعذرت آخر مزامنة."
        : `آخر مزامنة: ${dateTime(company.source.last_sync)}`,
      page: "connections",
    },
    {
      label: "واتساب",
      done: whatsappReady,
      detail: whatsappReady ? "متصل." : "غير متصل. يلزم لفحص الأرقام وإضافة العملاء.",
      page: "connections",
    },
    {
      label: "الفروع والجروبات",
      done: active.length > 0,
      detail: active.length ? `${number(active.length)} فرع مفعّل.` : "فعّل الفروع وحدد الجروبات.",
      page: "branches",
    },
  ];
  const events: Record<string, string> = {
    "company.created": "تم إنشاء مساحة الشركة",
    "source.synced": "اكتملت قراءة العملاء",
    "settings.updated": "تم تحديث إعدادات التشغيل",
    "branches.updated": "تم تحديث الفروع والجروبات",
    "processing.paused": "تم إيقاف المعالجة مؤقتًا",
    "processing.resumed": "تم استئناف المعالجة",
    "company.logo_updated": "تم تحديث شعار الشركة",
    "phone.checked": "تم فحص رقم على واتساب",
    "report.exported": "تم تصدير تقرير العملاء",
    "source.sync_failed": "تعذر تحديث بيانات المصدر",
  };
  return (
    <>
      <div className="page-heading">
        <h1>نظرة عامة</h1>
        <button
          className="button secondary"
          onClick={() => navigate("reports")}
        >
          التقرير اليومي
        </button>
      </div>
      {!steps.every((step) => step.done) && (
        <section className="panel setup-steps">
          <h2>حالة التشغيل</h2>
          {steps.map((step) => (
            <button key={step.label} onClick={() => navigate(step.page)}>
              <i className={"dot " + (step.done ? "green" : "gray")} />
              <strong>{step.label}</strong>
              <span>{step.detail}</span>
              <ArrowLeft size={15} />
            </button>
          ))}
        </section>
      )}
      <div className="stat-strip">
        {[
          { label: "كل العملاء", value: data.all.total },
          { label: "أرقام صحيحة", value: data.all.valid },
          { label: "تحتاج مراجعة", value: data.all.invalid },
          { label: "جدد اليوم", value: data.daily.total },
        ].map((s) => (
          <div key={s.label}>
            <span>{s.label}</span>
            <strong>{number(s.value)}</strong>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>العملاء حسب الفرع</h2>
            <button
              className="text-button"
              onClick={() => navigate("branches")}
            >
              إدارة الفروع
            </button>
          </div>
          <div className="branch-chart">
            {!active.length && <p className="subtle">لا توجد فروع مفعّلة.</p>}
            {active.slice(0, 7).map((b: any) => (
              <div className="branch-bar" key={b.branch_id}>
                <div>
                  <span>{b.name}</span>
                  <strong>{number(b.total)}</strong>
                </div>
                <div className="bar-track">
                  <span
                    style={{
                      width: `${Math.max(b.total ? 2 : 0, (b.total / max) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="panel data-quality">
          <div className="panel-heading">
            <h2>جودة الأرقام</h2>
          </div>
          <div className="quality-number">
            <strong>
              {data.all.total
                ? Math.round((data.all.valid / data.all.total) * 100)
                : 0}
              <span>%</span>
            </strong>
            <p>من الأرقام بصيغة مصرية صحيحة</p>
          </div>
          <div className="quality-track">
            <span
              style={{
                width: `${data.all.total ? (data.all.valid / data.all.total) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="quality-line">
            <span>
              <i className="dot green" />
              صيغة صحيحة
            </span>
            <strong>{number(data.all.valid)}</strong>
          </div>
          <div className="quality-line">
            <span>
              <i className="dot amber" />
              بحاجة لمراجعة
            </span>
            <strong>{number(data.all.invalid)}</strong>
          </div>
          <div className="quality-line">
            <span>
              <i className="dot gray" />
              صحيح ولم يُفحص واتساب
            </span>
            <strong>{number(data.all.unchecked)}</strong>
          </div>
          <button className="text-button quality-link" onClick={() => navigate("customers")}>
            مراجعة العملاء
          </button>
        </section>
      </div>
      <div className="overview-grid bottom-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>آخر النشاطات</h2>
          </div>
          <div className="activity-list">
            {data.events.map((e: any, i: number) => (
              <div className="activity" key={i}>
                <strong>{events[e.event] ?? "تحديث في بيانات الشركة"}</strong>
                <small>{dateTime(e.created_at)}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>مصدر البيانات</h2>
            <button className="text-button" onClick={() => navigate("connections")}>
              إدارة الاتصالات
            </button>
          </div>
          <div className="info-rows compact">
            <div>
              <span>المصدر</span>
              <strong>{company.source?.label ?? "غير مربوط"}</strong>
            </div>
            <div>
              <span>آخر قراءة</span>
              <strong>{dateTime(company.source?.last_sync)}</strong>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
export function Branches({ company, refresh, notify }: ViewProps) {
  const [rows, setRows] = useState<any[]>([]),
    [groups, setGroups] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [loadingBranches, setLoadingBranches] = useState(true),
    [loadingGroups, setLoadingGroups] = useState(false);

  const [distributionMode, setDistributionMode] = useState<"per_branch" | "global">(
    company.settings?.distributionMode || "per_branch",
  );
  const [globalGroupId, setGlobalGroupId] = useState<string | null>(
    company.settings?.globalGroupId || null,
  );
  const [globalGroupTitle, setGlobalGroupTitle] = useState<string | null>(
    company.settings?.globalGroupTitle || null,
  );

  const loadGroups = async (showNotification = false) => {
    if (company.whatsapp.status !== "ready") return;
    setLoadingGroups(true);
    try {
      const gList = await api("/whatsapp/groups");
      setGroups(gList);
      if (showNotification) {
        notify(`تم تحديث قائمة الجروبات (${gList.length} جروب متاح).`);
      }
    } catch (e) {
      if (showNotification) notify((e as Error).message, true);
    } finally {
      setLoadingGroups(false);
    }
  };

  useEffect(() => {
    let live = true;
    setLoadingBranches(true);
    void api("/branches")
      .then((data) => {
        if (live) setRows(data);
      })
      .catch((e) => {
        if (live) notify(e.message, true);
      })
      .finally(() => {
        if (live) setLoadingBranches(false);
      });

    return () => {
      live = false;
    };
  }, [company.id]);

  useEffect(() => {
    if (company.whatsapp.status === "ready" && groups.length === 0) {
      void loadGroups(false);
    }
  }, [company.whatsapp.status]);

  useEffect(() => {
    setDistributionMode(company.settings?.distributionMode || "per_branch");
    setGlobalGroupId(company.settings?.globalGroupId || null);
    setGlobalGroupTitle(company.settings?.globalGroupTitle || null);
  }, [company.id, company.settings?.distributionMode, company.settings?.globalGroupId]);

  async function save() {
    setBusy(true);
    try {
      // 1. Save distribution policy & global group into company settings
      await put("/settings", {
        ...company.settings,
        distributionMode,
        globalGroupId: globalGroupId || null,
        globalGroupTitle: globalGroupTitle || null,
      });

      // 2. Save branch configuration
      await put(
        "/branches",
        rows.map((b) => {
          const matchedGroup = groups.find((g) => g.id === b.group_id);
          return {
            programId: b.program_id,
            branchId: b.branch_id,
            enabled: Boolean(b.enabled),
            groupId: b.group_id || null,
            groupTitle: b.group_title || matchedGroup?.name || null,
            baseName: b.base_name || `${company.name} — ${b.name}`,
            nextCounter: b.next_counter || 2,
          };
        }),
      );
      const updatedRows = await api("/branches");
      setRows(updatedRows);
      await refresh();
      notify("تم حفظ سياسة التوزيع والفروع والجروبات بنجاح.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const updateRow = (index: number, patch: Record<string, any>) =>
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  const edit = (index: number, key: string, value: any) =>
    updateRow(index, { [key]: value });

  return (
    <>
      <div className="page-heading">
        <h1>الفروع والجروبات</h1>
        <Button
          kind="secondary"
          busy={loadingGroups}
          disabled={company.whatsapp.status !== "ready"}
          onClick={() => void loadGroups(true)}
        >
          <RefreshCw size={15} />
          {loadingGroups ? "جارٍ جلب الجروبات..." : "تحديث قائمة الجروبات"}
        </Button>
      </div>

      <div className="policy-switch-box">
        <span className="policy-label">طريقة توزيع وإضافة العملاء:</span>
        <div className="segmented-control">
          <button
            type="button"
            className={distributionMode === "per_branch" ? "active" : ""}
            onClick={() => setDistributionMode("per_branch")}
          >
            جروب مستقل لكل فرع
          </button>
          <button
            type="button"
            className={distributionMode === "global" ? "active" : ""}
            onClick={() => setDistributionMode("global")}
          >
            جروب موحد لجميع الفروع (جروب عام)
          </button>
        </div>
      </div>

      {distributionMode === "global" ? (
        <div className="global-group-card">
          <h3>الجروب العام الموحد لجميع الفروع</h3>
          <p>أي عميل جديد يتم تسجيله في أي فرع مفعّل، سيتم إضافته مباشرة إلى هذا الجروب العام.</p>
          <div className="form-grid">
            <Field
              label="جروب الواتساب الموحد"
              hint={groups.length > 0 ? `تم جلب ${groups.length} جروب من واتساب` : "تأكد من اتصال واتساب لتحميل قائمة الجروبات"}
            >
              <select
                dir="ltr"
                value={globalGroupId || ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setGlobalGroupId(val || null);
                  const matched = groups.find((g) => g.id === val);
                  if (matched) setGlobalGroupTitle(matched.name);
                  else if (!val) setGlobalGroupTitle(null);
                }}
              >
                <option value="">-- اختر الجروب الموحد من قائمة واتساب --</option>
                {globalGroupId && !groups.some((g) => g.id === globalGroupId) && (
                  <option value={globalGroupId}>
                    {globalGroupTitle || globalGroupId}
                  </option>
                )}
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="اسم الجروب الجديد عند الامتلاء (Rollover)" hint="الاسم التلقائي عند اكتمال الجروب الحالي (1000 عضو)">
              <input
                placeholder={`${company.name} — عام 2`}
                value={globalGroupTitle ? `${globalGroupTitle} 2` : `${company.name} — عام 2`}
                readOnly
              />
            </Field>
          </div>
        </div>
      ) : null}

      <section className="panel">
        <div className="table-scroll">
          <table className="data-table branch-table">
            <thead>
              <tr>
                <th>{distributionMode === "global" ? "مشمول في الجروب العام" : "مفعّل"}</th>
                <th>الفرع</th>
                <th>إجمالي العملاء</th>
                <th>أرقام صحيحة</th>
                {distributionMode === "per_branch" && (
                  <>
                    <th>جروب الواتساب الخاص بالفرع</th>
                    <th>اسم الجروب عند الامتلاء (Rollover)</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {loadingBranches && rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={distributionMode === "per_branch" ? 6 : 4}
                    style={{
                      textAlign: "center",
                      padding: "36px 20px",
                      color: "var(--muted)",
                    }}
                  >
                    <LoaderCircle
                      className="spin"
                      size={18}
                      style={{
                        display: "inline-block",
                        verticalAlign: "middle",
                        marginLeft: "8px",
                      }}
                    />
                    تحميل بيانات الفروع...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={distributionMode === "per_branch" ? 6 : 4}
                    style={{
                      textAlign: "center",
                      padding: "28px 20px",
                      color: "var(--muted)",
                    }}
                  >
                    لا توجد فروع مسجلة
                  </td>
                </tr>
              ) : (
                rows.map((b, i) => (
                  <tr key={`${b.program_id}:${b.branch_id}`}>
                    <td>
                      <input
                        aria-label={"تفعيل " + b.name}
                        type="checkbox"
                        checked={Boolean(b.enabled)}
                        onChange={(e) => edit(i, "enabled", e.target.checked)}
                      />
                    </td>
                    <td>
                      <strong>{b.name}</strong>
                      <small>كود الفرع {b.branch_id}</small>
                    </td>
                    <td>{number(b.customers)}</td>
                    <td>{number(b.valid)}</td>
                    {distributionMode === "per_branch" && (
                      <>
                        <td>
                          <select
                            aria-label={"جروب " + b.name}
                            value={b.group_id ?? ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              const matched = groups.find((g) => g.id === val);
                              updateRow(i, {
                                group_id: val || null,
                                group_title: matched ? matched.name : (val ? b.group_title : null),
                              });
                            }}
                          >
                            <option value="">غير مربوط</option>
                            {b.group_id && !groups.some((g) => g.id === b.group_id) && (
                              <option value={b.group_id}>
                                {b.group_title || b.group_id}
                              </option>
                            )}
                            {groups.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            aria-label={"اسم ترقية " + b.name}
                            placeholder={`${company.name} — ${b.name} 2`}
                            value={b.base_name ?? ""}
                            onChange={(e) => edit(i, "base_name", e.target.value)}
                          />
                        </td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="form-footer">
          <span className="subtle">
            التعديلات تسري على الإضافات التالية دون نقل الأعضاء المسجلين مسبقاً.
          </span>
          <Button busy={busy} onClick={() => void save()}>
            <Save size={16} />
            حفظ التغييرات
          </Button>
        </div>
      </section>
    </>
  );
}
export function Settings({ company, refresh, notify }: ViewProps) {
  const [settings, setSettings] = useState({ ...company.settings }),
    [name, setName] = useState(company.name),
    [logo, setLogo] = useState<File | null>(null),
    [busy, setBusy] = useState(false);

  useEffect(() => {
    setSettings({ ...company.settings });
    setName(company.name);
  }, [company.id]);

  const change = (key: string, value: unknown) =>
    setSettings({ ...settings, [key]: value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await put("/company", { name });
      await put("/settings", settings);
      if (logo) {
        const form = new FormData();
        form.append("logo", logo);
        await api("/company/logo", { method: "POST", body: form });
      }
      await refresh();
      setSettings({ ...settings });
      notify("تم حفظ إعدادات الشركة.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>الإعدادات</h1>
      </div>
      <form onSubmit={save} className="settings-form">
        <section className="panel form-panel">
          <h2 className="section-title">هوية الشركة</h2>
          <div className="form-grid">
            <Field label="اسم الشركة">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
              />
            </Field>
            <Field
              label="شعار الشركة"
              hint="PNG أو JPEG أو WebP حتى 2 ميجابايت"
            >
              <label className="upload-box">
                <ImagePlus size={20} />
                <span>{logo ? logo.name : "اختر صورة"}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => setLogo(e.target.files?.[0] ?? null)}
                />
              </label>
            </Field>
          </div>
        </section>
        <section className="panel form-panel">
          <h2 className="section-title">التوزيع ودفعات العملاء</h2>
          <div className="form-grid">
            <Field
              label="سياسة توزيع العملاء"
              hint="يمكنك أيضاً تحديد الجروبات واختيار الجروب الموحد مباشرة من شاشة الفروع والجروبات"
            >
              <select
                value={settings.distributionMode}
                onChange={(e) => change("distributionMode", e.target.value)}
              >
                <option value="per_branch">جروب مستقل لكل فرع</option>
                <option value="global">جروب عام لكل الفروع</option>
              </select>
            </Field>
            <Field
              label="حد فتح الجزء التالي"
              hint="يشمل الأدمن والأعضاء؛ الحد الأقصى للجروب 1024"
            >
              <input
                type="number"
                min={10}
                max={1024}
                value={settings.rolloverThreshold}
                onChange={(e) =>
                  change("rolloverThreshold", Number(e.target.value))
                }
              />
            </Field>
            <Field
              label="العملاء القدامى يوميًا"
              hint="صفر يعني إيقاف دفعات القديم"
            >
              <input
                type="number"
                min={0}
                max={10000}
                value={settings.historicalDailyLimit}
                onChange={(e) =>
                  change("historicalDailyLimit", Number(e.target.value))
                }
              />
            </Field>
            <Field label="العدد محسوب على">
              <select
                value={settings.historicalLimitScope}
                onChange={(e) => change("historicalLimitScope", e.target.value)}
              >
                <option value="total">إجمالي كل الفروع</option>
                <option value="per_branch">لكل فرع على حدة</option>
              </select>
            </Field>
            <Field label="بداية وقت العمل">
              <input
                type="time"
                value={settings.workStart}
                onChange={(e) => change("workStart", e.target.value)}
              />
            </Field>
            <Field label="نهاية وقت العمل" hint="كل المواعيد بتوقيت القاهرة">
              <input
                type="time"
                value={settings.workEnd}
                onChange={(e) => change("workEnd", e.target.value)}
              />
            </Field>
          </div>
        </section>
        <section className="panel form-panel">
          <h2 className="section-title">دعوة الخصوصية</h2>
          <label className="check-line">
            <input
              type="checkbox"
              checked={settings.inviteOnPrivacy}
              onChange={(e) => change("inviteOnPrivacy", e.target.checked)}
            />
            استخدام دعوة خاصة بالرابط عند تفعيل التشغيل الفعلي
          </label>
          <Field
            label="نص الدعوة"
            hint="المتغيرات: {customerName} · {companyName} · {destinationName} · {inviteLink}"
          >
            <textarea
              rows={4}
              value={settings.inviteTemplate}
              onChange={(e) => change("inviteTemplate", e.target.value)}
            />
          </Field>
          <Notice>
            تُرسل الدعوة عند تفعيل Live فقط، وبعد منع الإضافة بسبب الخصوصية.
            لن تُرسل أي دعوة أثناء المعاينة.
          </Notice>
        </section>
        <div className="settings-save">
          <Button busy={busy}>
            <Save size={17} />
            حفظ الإعدادات
          </Button>
        </div>
      </form>
    </>
  );
}
export function Connections({ company, refresh, notify }: ViewProps) {
  const [busy, setBusy] = useState(false),
    [editingSource, setEditingSource] = useState(false);
  const source = company.source;
  const whatsapp = company.whatsapp;
  async function action(path: string, body = {}) {
    setBusy(true);
    try {
      await post(path, body);
      await refresh();
      notify(path.includes("sync") ? "اكتملت المزامنة." : "تم تنفيذ الطلب.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>الاتصالات</h1>
      </div>
      <div className="connection-grid">
        <section className="panel form-panel">
          <div className="connection-title">
            <h2>
              <Database size={18} />
              قاعدة البيانات
            </h2>
            <Badge tone={!source ? "muted" : source.last_error ? "red" : "green"}>
              {!source ? "غير مربوطة" : source.last_error ? "فشلت آخر مزامنة" : "متصلة"}
            </Badge>
          </div>
          {!source || editingSource ? (
            <SourceSetup
              refresh={refresh}
              notify={notify}
              onCancel={source ? () => setEditingSource(false) : undefined}
            />
          ) : (
            <>
              <div className="info-rows">
                <div>
                  <span>المصدر</span>
                  <strong>{source.label}</strong>
                </div>
                <div>
                  <span>آخر مزامنة</span>
                  <strong>{dateTime(source.last_sync)}</strong>
                </div>
                <div>
                  <span>المزامنة التلقائية</span>
                  <strong>{source.kind === "sql" ? "كل 30 ثانية، ومراجعة كاملة كل ساعة" : "يدوية فقط"}</strong>
                </div>
              </div>
              {source.last_error && <Notice tone="error">{source.last_error}</Notice>}
              <div className="connection-actions">
                <Button kind="secondary" busy={busy} onClick={() => void action("/source/sync")}>
                  <RefreshCw size={15} />
                  مزامنة الآن
                </Button>
                {source.kind === "sql" && (
                  <Button kind="secondary" busy={busy} onClick={() => void action("/source/sync", { full: true })}>
                    مراجعة كاملة
                  </Button>
                )}
                <Button kind="secondary" onClick={() => setEditingSource(true)}>
                  تعديل الاتصال
                </Button>
              </div>
            </>
          )}
        </section>
        <section className="panel form-panel">
          <div className="connection-title">
            <h2>
              <Wifi size={18} />
              واتساب
            </h2>
            <Badge tone={whatsapp.status === "ready" ? "green" : (whatsapp.status === "error" || whatsapp.requiresReauth) ? "red" : whatsapp.status === "waiting_for_network" ? "amber" : "muted"}>
              {whatsapp.status === "ready"
                ? "متصل"
                : whatsapp.requiresReauth
                  ? "يلزم إعادة الربط"
                  : whatsapp.status === "waiting_for_network"
                    ? "في انتظار الشبكة"
                    : ["starting", "reconnecting"].includes(whatsapp.status)
                      ? (whatsapp.status === "reconnecting" ? "جارٍ استعادة الاتصال" : "جارٍ الاتصال")
                      : whatsapp.status === "qr"
                        ? "بانتظار المسح"
                        : whatsapp.status === "error"
                          ? "خطأ"
                          : "غير متصل"}
            </Badge>
          </div>
          {whatsapp.status === "ready" && (
            <div className="info-rows">
              {whatsapp.phone && (
                <div>
                  <span>الرقم</span>
                  <strong dir="ltr">+{whatsapp.phone}</strong>
                </div>
              )}
              {whatsapp.pushname && (
                <div>
                  <span>اسم الحساب</span>
                  <strong>{whatsapp.pushname}</strong>
                </div>
              )}
            </div>
          )}
          {whatsapp.status === "waiting_for_network" && (
            <p className="subtle">لا يوجد اتصال بالإنترنت. سيتم استئناف الاتصال تلقائيًا فور توفر الشبكة.</p>
          )}
          {["starting", "reconnecting"].includes(whatsapp.status) && !whatsapp.qr && (
            <p className="subtle">جارٍ تشغيل المتصفح. قد يستغرق ذلك دقيقة.</p>
          )}
          {whatsapp.qr && (
            <div className="qr">
              <img src={whatsapp.qr} alt="كود ربط واتساب" />
              <small>واتساب ← الأجهزة المرتبطة ← ربط جهاز</small>
            </div>
          )}
          {whatsapp.error && <Notice tone="error">{whatsapp.error}</Notice>}
          <div className="connection-actions">
            <Button
              busy={busy}
              disabled={["ready", "starting", "qr"].includes(whatsapp.status)}
              onClick={() => void action("/whatsapp/connect")}
            >
              <Link2 size={15} />
              ربط واتساب
            </Button>
            <Button
              kind="secondary"
              busy={busy}
              disabled={whatsapp.status === "disconnected"}
              onClick={() => void action("/whatsapp/disconnect")}
            >
              فصل الجلسة
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
