# 🎬 دمج الفيديوهات على Vercel — Node.js خالص (CommonJS)

موقع + API لدمج عدة مقاطع فيديو في ملف MP4 واحد عالي الجودة، يعمل بالكامل على Vercel Serverless Functions **بدون خطوة بناء** (No Build Step) وبدون خدمات تخزين خارجية — كل شيء داخل [Turso](https://turso.tech) (libSQL): بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج.

- **المعالجة داخل الدالة نفسها** عبر `ffmpeg-static` + `ffprobe-static` (مع دالة `ensureExecutable` التي تنسخ الثنائي إلى `/tmp` بصلاحية 755 عند الحاجة).
- **واجهة ثابتة** (HTML + CSS + JS داخل ملف واحد) في `public/index.html` — عربية RTL بثيم داكن حديث.
- **ملف `.env` يُحمَّل يدويًا (dotenv)** في كل نقطة دخول.

## البنية

```
merger-service/
├── api/                    # دوال Vercel Serverless
│   ├── jobs.js             # POST /api/jobs (إنشاء مهمة)
│   ├── jobs/[id].js        # GET حالة + DELETE حذف شامل
│   ├── jobs/[id]/process.js# POST تنفيذ الدمج متزامنًا
│   ├── jobs/[id]/video.js  # GET بث الناتج (Range + download)
│   ├── upload.js           # POST رفع أجزاء الملفات
│   ├── config.js           # GET الحدود والإصدار
│   └── cron.js             # GET حذف المهام المنتهية
├── lib/
│   ├── util.js             # CORS، ردود JSON، قراءة الجسم، origin، أدوات زمنية
│   ├── db.js               # عميل Turso + المخطط + CRUD + Blob 2MB + ادّعاء ذري
│   ├── store.js            # إعادة بناء المصادر من القاعدة إلى /tmp + تنزيل الروابط + بث الناتج
│   └── merge.js            # محرك ffmpeg/ffprobe + filter_complex + التقدم + الحدود
├── public/index.html       # واجهة الموقع (ملف واحد)
├── scripts/
│   ├── dev-server.js       # خادم تطوير نقي يحاكي Vercel على PORT (افتراضي 4000)
│   ├── test-unit.js        # اختبارات وحدة (ffmpeg + Turso)
│   └── test-http.js        # اختبارات HTTP ضد dev-server
├── vercel.json             # maxDuration=300 + cron يومي 2:00 صباحًا
└── .env.example            # متغيرات البيئة
```

## النشر على Vercel خطوة بخطوة

1. **أنشئ قاعدة Turso:**
   ```bash
   turso db create video-merger
   turso db show video-merger --url        # ← قيمة TURSO_DATABASE_URL
   turso db tokens create video-merger     # ← قيمة TURSO_AUTH_TOKEN
   ```
2. **ارفع الكود إلى مستودع Git** (GitHub/GitLab/Bitbucket) واربطه بـ Vercel: *Add New → Project → Import*.
3. **Root Directory:** إذا كان المشروع داخل مجلد فرعي (مثل `merger-service` داخل المستودع) اضبط *Root Directory* في إعدادات المشروع إلى هذا المجلد حتى يقرأ Vercel `api/` و`vercel.json` من المكان الصحيح.
4. **متغيرات البيئة:** من *Settings → Environment Variables* أضف (لـ Production وPreview):
   - `TURSO_DATABASE_URL` — مثل `libsql://video-merger-xxxx.turso.io`
   - `TURSO_AUTH_TOKEN` — رمز القاعدة
   - (اختياري) `MAX_SOURCES`, `SOURCE_MAX_MB`, `OUTPUT_MAX_MB`, `MAX_TOTAL_DURATION_SEC`, `FFMPEG_PRESET`
5. **Deploy** — لا خطوة بناء؛ Vercel يكتشف مجلد `api/` تلقائيًا ويرفع `maxDuration` إلى 300 ثانية من `vercel.json`.
6. **Crons:** ملف `vercel.json` يعرّف مهمة مجدولة على `/api/cron` كل يوم الساعة 2:00 صباحًا (UTC) لحذف المهام المنتهية — تُنشأ تلقائيًا بعد أول نشر.
7. **التنظيف الكسول:** بالإضافة إلى cron تُحذف المهام المنتهية تلقائيًا عند كل طلب إنشاء مهمة أو دمج.

## توثيق API

كل النقاط تُرجع ترويسات CORS مفتوحة (`Access-Control-Allow-Origin: *`) وتدعم `OPTIONS`، والأخطاء بصيغة `{"error":"رسالة عربية"}`.

| Method | Endpoint | الوظيفة |
|---|---|---|
| POST | `/api/jobs` | إنشاء مهمة دمج |
| POST | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| POST | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط الفيديو النهائي |
| GET | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| GET | `/api/jobs/<id>/video` | بث الناتج بدعم Range، و`?download=1` للتحميل |
| DELETE | `/api/jobs/<id>` | حذف فوري شامل |
| GET | `/api/config` | الحدود العامة + version |
| GET | `/api/cron` | حذف المهام المنتهية |

الأمثلة أدناه تستخدم `https://your-app.vercel.app` — استبدله بدومين مشروعك.

### 1) إنشاء مهمة

```bash
curl -X POST https://your-app.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
```

أو بصيغة المصادر (لدمج رابط مع ملف):

```bash
curl -X POST https://your-app.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"b.mp4","size":1048576,"mime":"video/mp4"}]}'
```

استجابة `201`:

```json
{
  "jobId": "6f1c2b8e9a0d4f5167",
  "status": "uploading",
  "statusUrl": "https://your-app.vercel.app/api/jobs/6f1c2b8e9a0d4f5167",
  "processUrl": "https://your-app.vercel.app/api/jobs/6f1c2b8e9a0d4f5167/process",
  "expiresAt": "2025-01-01T12:00:00.000Z",
  "uploads": [
    {"seq": 0, "kind": "url", "url": "https://your-app.vercel.app/api/upload?job=6f1c...&seq=0&chunk=0"},
    {"seq": 1, "kind": "file", "url": "https://your-app.vercel.app/api/upload?job=6f1c...&seq=1&chunk=0"}
  ],
  "uploadChunkBytes": 4194304
}
```

- مهمة من روابط فقط → `"status":"queued"` بلا `uploads`.
- الرفض: أقل من مصدرين → `400 "يلزم مقطعان على الأقل للدمج"`، أكثر من الحد → `400 "أقصى عدد مقاطع هو 10"`، رابط غير http/https → `400`، JSON تالف → `400 "JSON تالف"`.

### 2) رفع أجزاء الملفات

كل جزء ≤ 4MB ويُرسل ثنائيًا (`application/octet-stream`)، رقم الجزء يبدأ من 0:

```bash
split -b 4194304 b.mp4 part_
curl -X POST "https://your-app.vercel.app/api/upload?job=JOB_ID&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @part_aa
curl -X POST "https://your-app.vercel.app/api/upload?job=JOB_ID&seq=1&chunk=1" \
  -H "Content-Type: application/octet-stream" --data-binary @part_ab
```

استجابة `200`: `{"ok":true,"job":"...","seq":1,"chunk":0,"received":4194304,"uploadedBytes":8388608,"completed":false}` — جزء أكبر من 4MB → `413`.

### 3) تنفيذ الدمج (متزامن)

```bash
curl -X POST https://your-app.vercel.app/api/jobs/JOB_ID/process
```

استجابة `200` بعد انتهاء الدمج فعليًا:

```json
{
  "status": "done",
  "videoUrl": "https://your-app.vercel.app/api/jobs/JOB_ID/video",
  "downloadUrl": "https://your-app.vercel.app/api/jobs/JOB_ID/video?download=1",
  "size": 7340032,
  "duration": 21.4,
  "resolution": "1280x720",
  "expiresAt": "2025-01-01T12:00:00.000Z"
}
```

- مصادر غير مكتملة → `409` برسالة عربية.
- معالجة جارية بالفعل (نداء متزامن ثانٍ) → `202 {"status":"processing"}`.
- فشل (حد متجاوز/مصدر تالف/خطأ ترميز) → `500 {"error":"..."}` ويُوسم المهمة `failed`.

### 4) الحالة والتقدم

```bash
curl https://your-app.vercel.app/api/jobs/JOB_ID
```

```json
{"jobId":"...","status":"processing","progress":62,"expiresAt":"..."}
```

`status` إحدى: `queued | uploading | processing | done | failed`، و`progress` رقم 0–100. عند الاكتمال تُضاف `videoUrl` و`downloadUrl` و`size` و`duration` و`resolution`، وعند الفشل `error` برسالة عربية. غير موجودة → `404`.

### 5) بث الفيديو

```bash
# 100 بايت أولى → 206
curl -H "Range: bytes=0-99" https://your-app.vercel.app/api/jobs/JOB_ID/video

# تحميل كامل باسم ملف
curl -OJ "https://your-app.vercel.app/api/jobs/JOB_ID/video?download=1"
```

- مع Range → `206` + `Content-Range: bytes 0-99/TOTAL` + `Accept-Ranges: bytes`.
- بدون Range → `200` كامل. `Content-Type: video/mp4` دائمًا.

### 6) حذف شامل

```bash
curl -X DELETE https://your-app.vercel.app/api/jobs/JOB_ID
```

`200 {"ok":true}` — يحذف كل صفوف المهمة من `jobs` و`sources` و`source_chunks` و`output_chunks`. غير موجودة → `404`.

### 7) الحدود والإصدار

```bash
curl https://your-app.vercel.app/api/config
```

```json
{"version":"1.0.0","maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,"maxTotalDurationSec":600,"uploadChunkBytes":4194304,"blobChunkBytes":2097152}
```

### 8) تنظيف المهام المنتهية

```bash
curl https://your-app.vercel.app/api/cron
# {"deleted":3}
```

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | نعم | — | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | نعم (لقاعدة بعيدة) | — | رمز المصادقة |
| `MAX_SOURCES` | لا | `10` | أقصى عدد مقاطع لكل دمج |
| `SOURCE_MAX_MB` | لا | `200` | أقصى حجم لمصدر واحد |
| `OUTPUT_MAX_MB` | لا | `150` | أقصى حجم للفيديو الناتج |
| `MAX_TOTAL_DURATION_SEC` | لا | `600` | أقصى مجموع مدد المقاطع (ثوانٍ) |
| `FFMPEG_PRESET` | لا | `medium` | سرعة/جودة ترميز libx264 |
| `PORT` | لا | `4000` | منفذ خادم التطوير المحلي فقط |

## الحدود المفروضة

| الحد | القيمة | مكان الفرض | سلوك التجاوز |
|---|---|---|---|
| عدد المصادر | 10 | `POST /api/jobs` + محرك الدمج | `400` / فشل المهمة |
| حجم المصدر الواحد | 200MB | أثناء التنزيل/الرفع | `413` أو فشل برسالة عربية |
| حجم الناتج | 150MB | بعد الترميز | فشل برسالة عربية |
| مجموع المدد | 600 ثانية | بعد ffprobe | فشل برسالة عربية |
| جزء الرفع الواحد | 4MB | `/api/upload` | `413` |
| صف Blob في Turso | 2MB | داخلي (تقسيم تلقائي) | — |
| صلاحية المهمة | 24 ساعة | من لحظة الإنشاء | حذف بالتنظيف الكسول/cron |

## التطوير والاختبار محليًا

```bash
cp .env.example .env     # ثم املأ قيم Turso
npm install              # (لا تُنفَّذ ضمن هذه المرحلة)
npm run dev              # خادم على http://localhost:4000 يخدم public/ و/api/*
npm run test:unit        # اختبارات وحدة (تحتاج ffmpeg في PATH أو حزم ffmpeg-static)
npm run test:http        # اختبارات HTTP ضد dev-server على 4000
```

## ملاحظات الخطة المجانية

- **مدة الدالة:** `maxDuration: 300` في `vercel.json` — الخطة المجانية (Hobby) تسمح بمدد أقصر للدوال؛ إن لم تكفِ خفّف الحمل بضبط `FFMPEG_PRESET=veryfast` أو `ultrafast` أو قلّل الحدود (`MAX_TOTAL_DURATION_SEC`...).
- **حجم الطلب ~4.5MB:** حد Vercel لجسم الطلب الواحد هو السبب في تقسيم الرفع إلى أجزاء 4MB وإعادة المحاولة ×3 لكل جزء في الواجهة.
- **حجم Turso المجاني:** حصة تخزين محدودة — لهذا يُقسَّم كل Blob إلى صفوف 2MB، وتُحذف `source_chunks` فور نجاح الدمج، وتُحذف المهام المنتهية بالتنظيف الكسول + cron اليومي، ويحذف `DELETE` كل الصفوف فورًا.
- **ثنائي ffmpeg وحجم الحزمة:** `ffmpeg-static` + `ffprobe-static` يضيفان ~80MB لحجم الحزمة المفكوكة (ضمن حد Vercel ~250MB) — لا يُعتمد على أي نظام ملفات دائم، وكل الملفات المؤقتة في `/tmp` وتُنظَّف في `finally` دائمًا.
- **الادّعاء الذري:** نداءات `process` المتزامنة آمنة — الأول يغير الحالة عبر `UPDATE ... WHERE status != 'processing'` ويقرأ `rowsAffected`، والبقية تحصل على `202` فورًا.
