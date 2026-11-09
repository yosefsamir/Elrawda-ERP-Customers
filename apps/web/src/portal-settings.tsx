import { useEffect, useState, type FormEvent } from "react";
import {
  ExternalLink,
  KeyRound,
  Plus,
  Save,
  User,
  UserCheck,
  UserPlus,
  UserX,
} from "lucide-react";
import { api, post, put, dateTime } from "./api";
import { Button, Field, Notice, ToggleSwitch } from "./components";

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

      {/* 3. Photo Managers Accounts */}
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
