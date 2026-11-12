# اختبار Gemini على Windows بحساب مستقل (PoC)

هذه المجموعة عبارة عن اختبار معزول تمامًا للتحقق من قدرة متصفح Chromium في الإصدار `1.0.6` على الاحتفاظ بجلسة Google / Gemini وفك تشفير DPAPI عند التشغيل في الخلفية عبر Task Scheduler بحساب Windows مخصص مع خيار Password logon (بدون تسجيل دخول تفاعلي لهذا الحساب بعد إعادة التشغيل).

> **تأكيد الأمان والعزل:**
> - هذه الملفات **لا تعدّل** كود البرنامج الأساسي ولا توقف مهمة `WhatsAppERPOperations` ولا تلمس مجلد `C:\ProgramData\WhatsApp-ERP`.
> - كل ملفات الاختبار تُحفظ في مجلد مؤقت معزول فقط: `C:\Temp\gemini-poc`.
> - كلمة مرور الحساب المؤقت (`GeminiPoCTest`) يتم توليدها عشوائيًا بدون حفظها كنص واضح (Plaintext).

---

## طريقة التشغيل (بالترتيب)

لكل ملف `.ps1`: اضغط **كليك يمين (Right-click)** على الملف واختر **Run with PowerShell** (سيطلب منك صلاحية المسؤول UAC تلقائيًا).

> إذا ظهر تحذير Execution Policy على جهازك ولم يفتح السكربت بالكليك يمين، افتح PowerShell داخل هذا المجلد وشغّل:
> `powershell -ExecutionPolicy Bypass -File .\01-setup-and-login.ps1` (مع تغيير اسم الملف في كل خطوة).

---

### الخطوة 1: `01-setup-and-login.ps1`
- يتأكد من وجود ملفات التشغيل المطلوبة في `C:\WhatsApp-ERP\releases\1.0.6`.
- ينشئ حساب Windows قياسي مؤقت باسم `GeminiPoCTest` بكلمة مرور عشوائية.
- يجهز ملف تعريف Windows (`NTUSER.DAT`) ويفتح Chromium بشكل تفاعلي تحت هذا الحساب.
- **المطلوب منك:** سجّل الدخول بحساب Google على `https://gemini.google.com/app`، وانتظر حتى تظهر خانة كتابة الرسائل في Gemini، ثم **أغلق نافذة المتصفح Chromium**.

---

### الخطوة 2: `02-test-background.ps1`
- يسجل مهمة مجدولة مؤقتة باسم `GeminiPoCTest_Startup` بصلاحية `Password` logon (وليس `S4U`) لتعمل تلقائيًا عند بدء تشغيل Windows.
- يحذف ملف كلمة المرور المشفر المؤقت فور تسجيل المهمة في Windows Task Scheduler.
- يشغّل المهمة فورًا في الخلفية (Session 0) بنفس الحساب وبنفس مجلد البروفايل للتحقق من:
  - فك تشفير DPAPI (`Local State`).
  - بقاء جلسة Google / Gemini بدون إعادة تسجيل دخول.
  - تنفيذ طلب حقيقي بسيط في Gemini.

---

### الخطوة 3: إعادة تشغيل Windows ثم تشغيل `03-check-after-restart.ps1`
1. **أعد تشغيل جهاز Windows بالكامل (Restart)**.
2. بعد التشغيل، ادخل إلى **حسابك العادي فقط** (لا تسجل الدخول أبدًا بحساب `GeminiPoCTest`).
3. انتظر حوالي **30 إلى 60 ثانية** بعد فتح سطح المكتب حتى تعمل الشبكة وتنتهي مهمة البداية.
4. شغّل الملف **`03-check-after-restart.ps1`** (كليك يمين -> Run with PowerShell).
5. سيطبع لك النتيجة النهائية بوضوح (`PASS` أو `FAIL`)، وسيحفظ تقريرًا نظيفًا بدون أي أسرار أو كوكيز في:
   - `C:\Temp\gemini-poc\after-restart-report.txt`
   - `C:\Temp\gemini-poc\task-result.log`

**أرسل لي نص التقرير أو محتوى الملفين أعلاه للمراجعة.**

---

### الخطوة 4: `04-cleanup.ps1` (بعد انتهاء الاختبار)
- بعد أن تنتهي وتُرسل النتائج، شغّل **`04-cleanup.ps1`** لحذف:
  - المهمة المؤقتة `GeminiPoCTest_Startup`
  - الحساب المؤقت `GeminiPoCTest` وبروفايله
  - المجلد المؤقت `C:\Temp\gemini-poc`
- لن يلمس التطبيق الأساسي أو مهمة `WhatsAppERPOperations` أو بيانات الإنتاج.
