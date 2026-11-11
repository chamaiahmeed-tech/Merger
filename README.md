# مولّد الوسائط — خادم MCP + خدمة دمج الفيديو

خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة إدارة عربية كاملة — مبني وفق مواصفة «MCP Media Generator».

**ثلاث قدرات في أداة واحدة:**

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** مع صوت متزامن أصلي — الموديل: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد — عبر خدمة دمج مدمجة في هذا المستودع (`merger-service/`)

---

## بنية المستودع

```
/                     ← خادم MCP (Next.js App Router + TypeScript + Tailwind)
├── src/lib/          ← طبقة Turso، نظام المفاتيح المتسلسلة، المزودان، منسّق التوليد، عميل الدمج
├── src/app/mcp/      ← مسار /mcp (خادم MCP رسمي SDK — نقل Streamable HTTP)
├── src/app/api/      ← health / keys / tasks
├── src/components/   ← واجهة الإدارة العربية RTL (3 بطاقات)
└── merger-service/   ← خدمة دمج الفيديو المستقلة (Node.js خالص — دوال Vercel Serverless + ffmpeg)
```

---

## القواعد الجوهرية (مطبَّقة في الكود)

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر؛ تُخزَّن روابط النتائج في قاعدة Turso.
- **مفاتيح تسلسلية صارمة** حسب ترتيب الإضافة (`created_at ASC`) — ليس round-robin.
- **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة — نفس `task_id` ويُستأنف على المفتاح التالي.
- **نموذج الذكاء الاصطناعي لا يرى أبدًا** أخطاء المفاتيح أو الرصيد.
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد مع كل `get_task` (تهدئة ~45 ثانية).
- ملفات الدمج تُحذف من خدمة الدمج بعد 24 ساعة (تنبيه ثابت في ردود الأداة).
- إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`).

---

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة — تعيد الرابط جاهزًا أو `task_id` |
| `generate_video` | توليد فيديو بصوت متزامن — `task_id` ثم متابعة بـ `get_task` |
| `merge_videos` | دمج مقاطع بـ `urls` مباشرة أو `task_ids` لمهام مكتملة (حتى 10 مقاطع) |
| `get_task` | متابعة أي مهمة — حدّث حي من المزود/خدمة الدمج |
| `list_media` | استرجاع الوسائط المخزنة سابقًا بروابطها |

**إعداد العميل (ChatGPT / Claude / Cursor / Windsurf / Cline):**

```json
{ "mcpServers": { "media-generator": { "url": "https://<YOUR-DOMAIN>/mcp" } } }
```

في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
لـ Claude Desktop أضِف `"type": "http"` داخل كائن السيرفر.

---

## التشغيل المحلي

```bash
# 1) خادم MCP (المجلد الجذري)
cp .env.example .env.local   # وضع القيم الحقيقية
npm install
npm run dev                  # http://localhost:3000

# 2) خدمة الدمج (اختياري محليًا — مطلوبة لأداة merge_videos)
cd merger-service
cp .env.example .env         # وضع متغيري Turso
npm install
npm run dev                  # http://localhost:4000
# ثم اضبط في .env.local للخادم الرئيسي: MERGER_API_BASE=http://localhost:4000
```

افتح `http://localhost:3000` — لوحة الإدارة العربية: مدير المفاتيح + لوحة المهام الحية + بطاقة ربط السيرفر.

---

## متغيرات البيئة (المجلد الجذري)

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso (libsql://...) |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ للدمج | الرابط العام لخدمة الدمج (انظر أدناه) |
| `MCP_ACCESS_TOKEN` | — | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | — | تجاوز أسماء الموديلات لدى kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | — | تجاوز أسماء الموديلات لدى CometAPI |

## متغيرات البيئة (merger-service)

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | إلزاميان — كل شيء يُخزَّن في Turso |
| `MAX_SOURCES` | 10 | أقصى عدد مقاطع للدمج |
| `SOURCE_MAX_MB` | 200 | أقصى حجم لكل مصدر |
| `OUTPUT_MAX_MB` | 150 | أقصى حجم للناتج |
| `MAX_TOTAL_DURATION_SEC` | 600 | أقصى مجموع مدد المقاطع |
| `FFMPEG_PRESET` | medium | preset ترميز ffmpeg |

---

## النشر على Vercel (مشروعان من نفس المستودع)

### أ) خادم MCP (المجلد الجذري)

1. ارفع المستودع إلى GitHub (مفعل مسبقًا).
2. في Vercel: **Add New → Project** → اختر المستودع → **Root Directory = `./`** (الافتراضي).
3. أضف في **Settings → Environment Variables**: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE` (رابط مشروع الدمج بعد نشره في الخطوة ب).
4. **Deploy** — كل شيء يعمل لأن libSQL يتصل عبر HTTP ومسار `/mcp` يدعم البث (`maxDuration = 300`).

### ب) خدمة الدمج (مجلد `merger-service/`)

1. في Vercel: **Add New → Project** → نفس المستودع → **Root Directory = `merger-service`** (إعداد مهم!).
2. أضف متغيري Turso فقط.
3. **Deploy** — انسخ رابط النشر (`https://xxx.vercel.app`) وضعه في `MERGER_API_BASE` لمشروع أ) ثم أعد النشر.

> ملاحظات الخطة المجانية: أقصى مدة تنفيذ للدالة، حد حجم الطلب ≈ 4.5MB (الرفع يتم بأجزاء 4MB تلقائيًا)، وحجم Turso المجاني. ثنائي ffmpeg يُضمَّن عبر `ffmpeg-static` (انظر `merger-service/README.md` للتفاصيل الكاملة وحدود الخدمة).

### ج) قاعدة Turso (مرة واحدة)

```bash
turso db create <name>
turso db show <name> --url        # → TURSO_DATABASE_URL
turso db tokens create <name>     # → TURSO_AUTH_TOKEN
```

الجداول تُنشأ تلقائيًا عند أول تشغيل (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأي migration.

---

## اختبار سريع بعد النشر

```bash
# الجهوزية
curl https://<YOUR-DOMAIN>/api/health

# تهيئة جلسة MCP
curl -X POST https://<YOUR-DOMAIN>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# قائمة الأدوات
curl -X POST https://<YOUR-DOMAIN>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

---

## ما المُختبَر فعليًا (e2e بمفاتيح حقيقية)

- ✅ `tsc --noEmit` نظيف و `next build` ينجح.
- ✅ `/api/health` يرجع `ok:true` و `database:"turso-connected"`.
- ✅ `tools/list` يعرض الأدوات الخمس بمخططاتها.
- ✅ توليد صورة حقيقية عبر kie.ai → رابط صورة يعمل.
- ✅ توليد فيديو حقيقي → `task_id` ثم `get_task` حتى رابط فيديو صالح.
- ✅ التبديل التسلسلي: مفتاح خاطئ أولًا ثم صحيح → المهمة اكتملت على الثاني، الخاطئ صار `disabled`، ولم يصل العميل أي ذكر للمفاتيح.
- ✅ دمج مقطعين عامين → MP4 نهائي على نطاق خدمة الدمج يعمل ببث Range (206).
- ✅ `merge_videos` يرفض مقطعًا واحدًا وأكثر من 10 برسائل عربية، ويحل `task_ids` بالترتيب.
- ✅ `list_media` يعيد المهام بروابطها من الأحدث.
- ✅ اختبارات خدمة الدمج: 6/6 وحدات + 10/10 HTTP (انظر `merger-service`).
