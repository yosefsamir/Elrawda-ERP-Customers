# مقارنة نسخة قاعدة البيانات الجديدة

المصدر: `db/db.rar`، والملفات المستخرجة بتاريخ 27 أكتوبر 2026.

- مقارنة جميع جداول المستخدم: 315 جدولًا في النسخة السابقة و336 في الجديدة.
- 238 عمودًا إضافيًا و19 اختلاف تعريف في جداول أخرى؛ لا أعمدة محذوفة.
- كل أعمدة قراءة العملاء والفروع المطلوبة موجودة. لا تغيرات تعريف في الجداول person وkindperson وbranch وbranchmain وprogramitems.
- إضافات ضمن الجداول المرتبطة: branchmain.idno_sprintcountr, kindperson.fprlist2kindperson, kindperson.showforuser36, branchmain.idno_scountrestart, kindperson.showforuser64, branchmain.restartidno_suserforalluser, kindperson.fprlistkindperson, kindperson.showforuser58.
- استعلام العملاء الحالي أعاد 35,121 صفًا ضمن البرنامج والفروع التسعة المختارة.
- جدول person ما زال لا يحتوي تاريخ تسجيل/تعديل أو rowversion؛ التقرير اليومي يعتمد على أول اكتشاف محلي ويستثني baseline.
- فحص SHA256 أكد عدم تغيير ملفات المصدر. استخدمت نسخًا منفصلة داخل SQL Server معزول عن الشبكة، وحذفت الحاوية ونسخها المؤقتة بعد الانتهاء.

التفاصيل في [نتيجة المقارنة](database-schema-comparison.json). بيانات العملاء الخاصة محفوظة محليًا تحت data/database-review ومستبعدة من المستودع.
