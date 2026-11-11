import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  LogIn,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  User,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import { api, post, put, dateTime } from "./api";
import { Button, Field, Notice, ToggleSwitch } from "./components";

type GeminiStatus = {
  enabled?: boolean;
  paused: boolean;
  requiresReauth: boolean;
  pauseReason: string | null;
  profileExists: boolean;
  authenticatedAt?: string | null;
  counts: { pending: number; processing: number; completed: number; failed: number };
};

type InteractiveLoginState = {
  status: "idle" | "launching" | "waiting_for_login" | "confirming" | "succeeded" | "failed" | "cancelled";
  stage: "launching" | "waiting_for_login" | "confirming" | null;
  active: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  interactiveSupported: boolean;
  unsupportedReason: string | null;
};

type PhotoUser = {
  id: string;
  username: string;
  enabled: number;
  created_at?: string;
};

export function PortalSettings({
  companyId,
  notify,
}: {
  companyId: string;
  notify: (s: string, error?: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [origin, setOrigin] = useState("");
  const [users, setUsers] = useState<PhotoUser[]>([]);
  const [imagePrompt, setImagePrompt] = useState("");
  const [defaultImagePrompt, setDefaultImagePrompt] = useState("");
  const [processingEnabled, setProcessingEnabled] = useState(true);
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null);
  const [interactiveLogin, setInteractiveLogin] = useState<InteractiveLoginState | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [hasWatermarkLogo, setHasWatermarkLogo] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);
  const [logoBusy, setLogoBusy] = useState(false);
  const watermarkInputRef = useRef<HTMLInputElement | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    const result = await api("/portal/settings");
    setEnabled(Boolean(result.enabled));
    setOrigin(result.origin || "");
    setUsers(result.users || []);
    setImagePrompt(result.imagePrompt || result.defaultImagePrompt || "");
    setDefaultImagePrompt(result.defaultImagePrompt || "");
    setProcessingEnabled(
      result.imageProcessingEnabled !== undefined
        ? Boolean(result.imageProcessingEnabled)
        : Boolean(result.geminiStatus?.enabled ?? true),
    );
    setGeminiStatus(result.geminiStatus || null);
    setInteractiveLogin(result.interactiveLogin || null);
    setHasWatermarkLogo(Boolean(result.hasWatermarkLogo));
    setError("");
  }

  useEffect(() => {
    setLoading(true);
    setResetId(null);
    setPassword("");
    setResetPassword("");
    void load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [companyId]);

  useEffect(() => {
    if (!interactiveLogin?.active) return;
    const timer = window.setInterval(() => {
      void api("/portal/image-processing/login/status")
        .then((res) => {
          if (res.interactiveLogin) setInteractiveLogin(res.interactiveLogin);
          if (res.geminiStatus) {
            setGeminiStatus(res.geminiStatus);
            if (res.geminiStatus.enabled !== undefined) {
              setProcessingEnabled(Boolean(res.geminiStatus.enabled));
            }
          }
          if (res.interactiveLogin && !res.interactiveLogin.active) {
            if (res.interactiveLogin.status === "succeeded") {
              notify("تم تسجيل الدخول إلى Gemini Web وحفظ الجلسة بنجاح.");
            } else if (res.interactiveLogin.status === "failed" && res.interactiveLogin.error) {
              notify(res.interactiveLogin.error, true);
            } else if (res.interactiveLogin.status === "cancelled") {
              notify("تم إلغاء عملية تسجيل الدخول.");
            }
          }
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [interactiveLogin?.active]);

  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await work();
      await load();
      notify(message);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  // Instant toggle for the service
  async function handleToggleService(nextState: boolean) {
    setEnabled(nextState);
    await action(
      () => put("/portal/settings", { enabled: nextState, origin: origin.trim() }),
      nextState
        ? "تم تفعيل خدمة استعلام الأصناف والأسعار بنجاح."
        : "تم إيقاف خدمة استعلام الأصناف والأسعار مؤقتًا.",
    );
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    await action(
      () => put("/portal/settings", { enabled, origin: origin.trim() }),
      "تم حفظ إعدادات الأصناف والأسعار بنجاح.",
    );
  }

  async function saveImagePrompt(e: FormEvent) {
    e.preventDefault();
    await action(
      () => put("/portal/image-processing/prompt", { imagePrompt }),
      "تم حفظ برومبت معالجة الصور بنجاح.",
    );
  }

  async function handleWatermarkFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      notify("حجم صورة اللوجو كبير جدًا؛ الحد الأقصى 2 ميجابايت", true);
      return;
    }
    setLogoBusy(true);
    try {
      const form = new FormData();
      form.append("logo", file);
      await api("/portal/image-processing/watermark-logo", { method: "POST", body: form });
      setHasWatermarkLogo(true);
      setLogoVersion((v) => v + 1);
      notify("تم حفظ لوجو الشركة على صور المنتجات.");
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setLogoBusy(false);
    }
  }

  async function removeWatermarkLogo() {
    setLogoBusy(true);
    try {
      await api("/portal/image-processing/watermark-logo", { method: "DELETE" });
      setHasWatermarkLogo(false);
      setLogoVersion((v) => v + 1);
      notify("تمت إزالة اللوجو؛ سيُضاف كود الصنف فقط أسفل الصور.");
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setLogoBusy(false);
    }
  }

  async function resumeImageProcessing() {
    await action(
      () => post("/portal/image-processing/resume", {}),
      "تم استئناف طابور معالجة الصور بنجاح.",
    );
  }

  async function handleToggleImageProcessing(nextState: boolean) {
    setProcessingEnabled(nextState);
    await action(
      () => put("/portal/image-processing/enabled", { enabled: nextState }),
      nextState
        ? "تم تفعيل معالجة الصور التلقائية بنجاح."
        : "تم إيقاف معالجة الصور التلقائية؛ ستظهر الصور المرفوعة كما هي بدون إضافتها للطابور.",
    );
  }

  async function startGeminiLogin() {
    setLoginBusy(true);
    try {
      const res = await post("/portal/image-processing/login", {});
      if (res.interactiveLogin) {
        setInteractiveLogin(res.interactiveLogin);
      }
      notify("تم فتح نافذة المتصفح؛ سجّل الدخول إلى حساب Google في النافذة المفتوحة.");
    } catch (e) {
      notify((e as Error).message, true);
      await load().catch(() => {});
    } finally {
      setLoginBusy(false);
    }
  }

  async function cancelGeminiLogin() {
    setLoginBusy(true);
    try {
      const res = await post("/portal/image-processing/login/cancel", {});
      if (res.interactiveLogin) {
        setInteractiveLogin(res.interactiveLogin);
      }
      await load().catch(() => {});
      notify("تم إرسال طلب إلغاء تسجيل الدخول.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoginBusy(false);
    }
  }

  async function createPhotoUser(e: FormEvent) {
    e.preventDefault();
    await action(async () => {
      await post("/portal/users", { username: username.trim(), password });
      setUsername("");
      setPassword("");
    }, "تم إنشاء حساب مسؤول الصور بنجاح.");
  }

  async function toggleUser(user: PhotoUser) {
    const next = !user.enabled;
    await action(
      () => put(`/portal/users/${user.id}`, { enabled: next }),
      next ? "تم تفعيل حساب مسؤول الصور." : "تم تعطيل الحساب وإلغاء جلساته.",
    );
  }

  async function submitResetPassword(e: FormEvent, userId: string) {
    e.preventDefault();
    await action(async () => {
      const user = users.find((u) => u.id === userId);
      await put(`/portal/users/${userId}`, {
        enabled: Boolean(user?.enabled ?? 1),
        password: resetPassword,
      });
      setResetId(null);
      setResetPassword("");
    }, "تم تغيير كلمة المرور وإلغاء الجلسات النشطة للحساب.");
  }

  if (loading) {
    return (
      <section className="panel form-panel">
        <div className="loading">جاري تحميل إعدادات الأصناف والأسعار…</div>
      </section>
    );
  }

  const portalUrl = origin || "http://127.0.0.1:3212";

  return (
    <div className="settings-subpage">
      {error && <Notice tone="error">{error}</Notice>}

      {/* 1. Main Service Activation Toggle Card */}
      <section className="panel form-panel">
        <h2 className="section-title">حالة خدمة استعلام الأصناف والأسعار</h2>
        <p className="panel-subtitle">
          التحكم في تشغيل أو إيقاف صفحة البحث في موديلات ومنتجات الشركة والاطلاع على أسعار البيع المعتمدة مباشرةً من نظام الـ ERP.
        </p>

        <ToggleSwitch
          id="portal-service-toggle"
          title="خدمة استعلام الأصناف والأسعار المباشرة"
          description="عند التفعيل، يمكن للعملاء ومسؤولي المبيعات استعلام تفاصيل الموديلات والأسعار لحظياً بدون الحاجة لتسجيل دخول. عند الإيقاف تظهر صفحة صيانة آمنة."
          checked={enabled}
          onChange={handleToggleService}
          disabled={busy}
          badgeActive="الخدمة مفعّلة ونشطة"
          badgeInactive="الخدمة متوقفة حاليًا"
        />

        {enabled && (
          <div className="portal-quick-link-box">
            <div className="portal-quick-link-text">
              <span className="portal-link-label">رابط صفحة الاستعلام المباشر:</span>
              <code className="portal-link-code">{portalUrl}</code>
            </div>
            <a
              href={portalUrl}
              target="_blank"
              rel="noreferrer"
              className="button secondary portal-open-btn"
            >
              <ExternalLink size={16} />
              <span>فتح صفحة الاستعلام والمعاينة</span>
            </a>
          </div>
        )}
      </section>

      {/* 2. Public Domain & Connection Settings */}
      <form onSubmit={saveSettings} className="panel form-panel">
        <h2 className="section-title">رابط وعنوان الوصول الخارجي</h2>
        <p className="panel-subtitle">
          إذا قمت بربط نطاق خارجي أو Cloudflare Tunnel للوصول للأسعار خارج مقر الشركة، قم بإدخال العنوان المعتمد هنا.
        </p>

        <div className="form-grid">
          <Field
            label="عنوان الاستعلام الخارجي (HTTPS Origin)"
            hint="عنوان HTTPS معتمد بدون مسار إضافي، مثل: https://prices.alrawda.com. اتركه فارغاً للاستخدام المحلي أو الشبكة الداخلية."
          >
            <input
              dir="ltr"
              type="url"
              placeholder="https://prices.alrawda.com"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        <div className="form-footer-action">
          <Button busy={busy}>
            <Save size={16} />
            حفظ إعدادات الرابط
          </Button>
        </div>
      </form>

      {/* 3. Gemini Image Processing Settings */}
      <section className="panel form-panel" aria-labelledby="gemini-processing-heading">
        <div className="section-header-row">
          <div>
            <h2 id="gemini-processing-heading" className="section-title">
              <Sparkles size={18} style={{ verticalAlign: "text-bottom", marginInlineEnd: 6 }} />
              تحسين صور المنتجات تلقائيًا
            </h2>
            <p className="panel-subtitle">
              تجهيز وتحسين صور الموديلات تلقائيًا بعد رفعها مع بقاء الصورة الأصلية ظاهرة فورًا.
            </p>
          </div>
          <div className="gemini-header-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void load().catch((e) => notify((e as Error).message, true))}
            >
              <RefreshCw size={15} />
              <span>تحديث</span>
            </button>
          </div>
        </div>

        <ToggleSwitch
          id="gemini-image-processing-toggle"
          title="تفعيل التحسين التلقائي للصور"
          description="عند التفعيل يتم تحسين الصور المرفوعة تلقائيًا، وعند الإيقاف تظهر الصور كما هي فورًا بدون تعديل."
          checked={processingEnabled}
          onChange={handleToggleImageProcessing}
          disabled={busy || loginBusy}
          badgeActive="مفعّل"
          badgeInactive="متوقف"
        />

        {geminiStatus && (
          <div className="gemini-status-panel">
            <div className="gemini-account-card">
              <div className="gemini-account-info">
                <span
                  className={`portal-user-badge ${
                    geminiStatus.requiresReauth || !geminiStatus.profileExists
                      ? "inactive"
                      : !processingEnabled || geminiStatus.paused
                        ? "warning"
                        : "active"
                  }`}
                >
                  {geminiStatus.requiresReauth || !geminiStatus.profileExists ? (
                    <>
                      <AlertTriangle size={13} style={{ verticalAlign: "text-bottom", marginInlineEnd: 4 }} />
                      حساب Google غير متصل
                    </>
                  ) : !processingEnabled ? (
                    "متوقف مؤقتًا (الحساب متصل)"
                  ) : geminiStatus.paused ? (
                    "الخدمة متوقفة مؤقتًا"
                  ) : (
                    "الحساب متصل وجاهز"
                  )}
                </span>
                <span className="gemini-account-hint">
                  {geminiStatus.requiresReauth || !geminiStatus.profileExists
                    ? "سجّل الدخول مرة واحدة لبدء تحسين الصور تلقائيًا."
                    : !processingEnabled
                      ? "الصور الجديدة تُعرض مباشرةً بدون تعديل حتى تعيد التفعيل."
                      : "يتم تحسين الصور الجديدة تلقائيًا في الخلفية."}
                </span>
              </div>

              <div className="gemini-account-actions">
                {(geminiStatus.paused || geminiStatus.requiresReauth) && processingEnabled && !interactiveLogin?.active && (
                  <Button
                    type="button"
                    busy={busy}
                    onClick={() => void resumeImageProcessing()}
                  >
                    <Play size={15} />
                    <span>استئناف</span>
                  </Button>
                )}

                {interactiveLogin?.active ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={loginBusy}
                    onClick={() => void cancelGeminiLogin()}
                  >
                    <X size={15} />
                    <span>إلغاء</span>
                  </button>
                ) : !geminiStatus.profileExists || geminiStatus.requiresReauth ? (
                  <Button
                    type="button"
                    busy={loginBusy}
                    disabled={busy || interactiveLogin?.interactiveSupported === false}
                    onClick={() => void startGeminiLogin()}
                  >
                    <LogIn size={15} />
                    <span>تسجيل الدخول بالحساب</span>
                  </Button>
                ) : (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || loginBusy || interactiveLogin?.interactiveSupported === false}
                    onClick={() => void startGeminiLogin()}
                  >
                    <LogIn size={15} />
                    <span>تغيير / إعادة ربط الحساب</span>
                  </button>
                )}
              </div>
            </div>

            {interactiveLogin?.active && (
              <Notice tone="info">
                <LoaderCircle size={15} className="spin" style={{ verticalAlign: "text-bottom", marginInlineEnd: 6 }} />
                {interactiveLogin.stage === "launching"
                  ? "جاري فتح المتصفح…"
                  : interactiveLogin.stage === "confirming"
                    ? "جاري تأكيد الحساب وحفظ الجلسة…"
                    : "المتصفح مفتوح الآن — سجّل الدخول إلى حساب Google وستُغلق النافذة تلقائيًا بعد الحفظ."}
              </Notice>
            )}

            {!interactiveLogin?.active && interactiveLogin?.status === "failed" && interactiveLogin.error && (
              <Notice tone="error">{interactiveLogin.error}</Notice>
            )}

            {interactiveLogin && !interactiveLogin.interactiveSupported && (!geminiStatus.profileExists || geminiStatus.requiresReauth) && (
              <Notice tone="info">
                {interactiveLogin.unsupportedReason ||
                  "يعمل الخادم حاليًا كخدمة خلفية؛ افتح ملف gemini-login.bat من جهاز الخادم لتسجيل الدخول."}
              </Notice>
            )}

            {geminiStatus.pauseReason && processingEnabled && (
              <Notice tone={geminiStatus.requiresReauth ? "error" : "info"}>
                {geminiStatus.pauseReason}
              </Notice>
            )}

            <div className="gemini-metrics-grid">
              <div className="gemini-metric-card">
                <span className="gemini-metric-value">{geminiStatus.counts.pending}</span>
                <span className="gemini-metric-label">في الانتظار</span>
              </div>
              <div className="gemini-metric-card">
                <span className="gemini-metric-value">{geminiStatus.counts.processing}</span>
                <span className="gemini-metric-label">قيد التحسين</span>
              </div>
              <div className="gemini-metric-card">
                <span className="gemini-metric-value">{geminiStatus.counts.completed}</span>
                <span className="gemini-metric-label">مكتملة</span>
              </div>
              <div className="gemini-metric-card">
                <span className="gemini-metric-value">{geminiStatus.counts.failed}</span>
                <span className="gemini-metric-label">تعذرت</span>
              </div>
            </div>
          </div>
        )}

        <div className="gemini-account-card watermark-logo-card">
          <div className="watermark-logo-info">
            <div className="logo-preview-box watermark-logo-preview">
              {hasWatermarkLogo ? (
                <img
                  src={`/api/portal/image-processing/watermark-logo?v=${logoVersion}`}
                  alt="لوجو الشركة"
                  className="logo-preview-img"
                />
              ) : (
                <ImagePlus size={22} className="watermark-logo-placeholder" />
              )}
            </div>
            <div className="watermark-logo-text">
              <strong>لوجو الشركة وكود الصنف على الصورة</strong>
              <span className="gemini-account-hint">
                يُطبع اللوجو تلقائيًا أعلى يمين الصورة، ويُكتب كود الصنف بوضوح أسفل اليسار على كل صورة محسّنة (بحد أقصى 2 ميجابايت).
              </span>
            </div>
          </div>

          <div className="gemini-account-actions">
            <input
              ref={watermarkInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              disabled={busy || logoBusy}
              onChange={handleWatermarkFileChange}
            />
            <button
              type="button"
              className="button secondary"
              disabled={busy || logoBusy}
              onClick={() => watermarkInputRef.current?.click()}
            >
              {logoBusy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
              <span>{hasWatermarkLogo ? "تغيير اللوجو" : "رفع لوجو الشركة"}</span>
            </button>
            {hasWatermarkLogo && (
              <button
                type="button"
                className="button secondary watermark-remove-btn"
                disabled={busy || logoBusy}
                onClick={() => void removeWatermarkLogo()}
              >
                <Trash2 size={15} />
                <span>إزالة</span>
              </button>
            )}
          </div>
        </div>

        <details className="gemini-advanced-details">
          <summary className="gemini-advanced-summary">
            <span className="gemini-advanced-title">
              <ChevronDown size={16} className="gemini-advanced-chevron" />
              <span>تخصيص وصف تعديل الصور</span>
            </span>
            <span className="gemini-advanced-badge">اختياري</span>
          </summary>

          <form onSubmit={saveImagePrompt} className="gemini-prompt-form">
            <div className="field">
              <label htmlFor="gemini-image-prompt">وصف تعديل الصورة</label>
              <textarea
                id="gemini-image-prompt"
                name="imagePrompt"
                dir="auto"
                className="gemini-prompt-textarea"
                rows={4}
                maxLength={4000}
                value={imagePrompt}
                onChange={(e) => setImagePrompt(e.target.value)}
                aria-describedby="gemini-prompt-hint"
                disabled={busy}
              />
              <small id="gemini-prompt-hint">
                التعليمات المرسلة تلقائيًا عند تحسين كل صورة جديدة. اتركه فارغًا لاستخدام الوصف الافتراضي.
              </small>
            </div>

            <div className="form-footer-action gemini-prompt-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy || !defaultImagePrompt}
                onClick={() => setImagePrompt(defaultImagePrompt)}
              >
                <RotateCcw size={15} />
                <span>استعادة الافتراضي</span>
              </button>
              <Button busy={busy}>
                <Save size={16} />
                حفظ التعديلات
              </Button>
            </div>
          </form>
        </details>
      </section>

      {/* 4. Photo Managers Accounts */}
      <section className="panel form-panel">
        <div className="section-header-row">
          <div>
            <h2 className="section-title">حسابات مسؤولي إدارة الصور</h2>
            <p className="panel-subtitle">
              حسابات مخصصة للموظفين المكلفين بتصوير الأصناف ورفع وحذف صور الموديلات. هذه الحسابات ليس لها أي صلاحية على واتساب أو إعدادات النظام.
            </p>
          </div>
        </div>

        {/* Create new photo manager user form */}
        <form onSubmit={createPhotoUser} className="portal-create-user-card">
          <h3 className="card-inner-title">
            <UserPlus size={18} />
            إضافة حساب مسؤول صور جديد
          </h3>
          <div className="form-grid">
            <Field label="اسم المستخدم">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="مثال: photo_admin"
                minLength={3}
                maxLength={80}
                required
                autoComplete="off"
                disabled={busy}
              />
            </Field>
            <Field
              label="كلمة المرور"
              hint="10 أحرف على الأقل، تشمل أمان عالي؛ لا تعرض بعد الحفظ."
            >
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                minLength={10}
                maxLength={200}
                required
                autoComplete="new-password"
                disabled={busy}
              />
            </Field>
          </div>
          <div className="form-inline-action">
            <Button busy={busy}>
              <Plus size={16} />
              إضافة الحساب
            </Button>
          </div>
        </form>

        {/* List of existing photo manager accounts */}
        <div className="portal-user-list-section">
          <h3 className="card-inner-title">
            <User size={18} />
            الحسابات الحالية المسجلة ({users.length})
          </h3>

          {users.length === 0 ? (
            <div className="portal-empty-users">
              <p>لم تُنشأ أي حسابات لمسؤولي الصور بعد. استخدم النموذج أعلاه لإنشاء أول حساب.</p>
            </div>
          ) : (
            <div className="portal-users-grid">
              {users.map((user) => (
                <div key={user.id} className="portal-user-card">
                  <div className="portal-user-header">
                    <div className="portal-user-avatar">
                      <User size={20} />
                    </div>
                    <div className="portal-user-meta">
                      <strong className="portal-username">{user.username}</strong>
                      <span className={`portal-user-badge ${user.enabled ? "active" : "inactive"}`}>
                        {user.enabled ? "مفعّل" : "معطّل"}
                      </span>
                    </div>
                  </div>

                  {user.created_at && (
                    <div className="portal-user-date">
                      تاريخ الإنشاء: {dateTime(user.created_at)}
                    </div>
                  )}

                  <div className="portal-user-actions">
                    <button
                      type="button"
                      disabled={busy}
                      className="portal-user-btn"
                      onClick={() => {
                        setResetId(resetId === user.id ? null : user.id);
                        setResetPassword("");
                      }}
                    >
                      <KeyRound size={14} />
                      تغيير كلمة المرور
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      className={`portal-user-btn ${user.enabled ? "danger" : "success"}`}
                      onClick={() => void toggleUser(user)}
                    >
                      {user.enabled ? (
                        <>
                          <UserX size={14} />
                          تعطيل الحساب
                        </>
                      ) : (
                        <>
                          <UserCheck size={14} />
                          تفعيل الحساب
                        </>
                      )}
                    </button>
                  </div>

                  {/* Inline reset password form */}
                  {resetId === user.id && (
                    <form
                      className="portal-reset-form"
                      onSubmit={(e) => void submitResetPassword(e, user.id)}
                    >
                      <Field
                        label="كلمة المرور الجديدة"
                        hint="10 أحرف على الأقل؛ تلغي كافة الجلسات الحالية فورًا."
                      >
                        <input
                          type="password"
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          placeholder="كلمة المرور الجديدة…"
                          minLength={10}
                          maxLength={200}
                          required
                          autoComplete="new-password"
                          disabled={busy}
                        />
                      </Field>
                      <div className="portal-reset-actions">
                        <Button busy={busy}>حفظ كلمة المرور</Button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            setResetId(null);
                            setResetPassword("");
                          }}
                        >
                          إلغاء
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
