'use strict';
/* POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا بشكل متزامن:
   ينزّل المصادر ← يرمّز ← يحفظ، ويرجع النتيجة مباشرة.
   - مهمة قيد المعالجة فعله → 202 {"status":"processing"} (عبر الادّعاء الذري)
   - المصادر غير جاهزة → 409 برسالة عربية
   - فشل → 500 {"error":"..."} مع وسم المهمة failed في القاعدة
   - مكتملة سابقًا → تعاد النتيجة نفسها دون إعادة ترميز */

require('dotenv').config();
const { sendJson, sendError, handleOptions, getOrigin, nowIso } = require('../../../lib/util');
const dbm = require('../../../lib/db');
const merge = require('../../../lib/merge');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return sendError(res, 405, 'طريقة غير مسموحة');
  const id = String((req.query || {}).id || '');
  try {
    await dbm.ensureSchema();
    try { await dbm.cleanupExpired(); } catch (_) {} // تنظيف كسول عند كل دمج
    if (!id) return sendError(res, 400, 'معرف المهمة مفقود');

    const job = await dbm.getJob(id);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة');

    const origin = getOrigin(req);
    const videoUrl = `${origin}/api/jobs/${id}/video`;

    // اكتملت سابقًا؟ أعِد نفس النتيجة فورًا
    if (job.status === 'done' && job.video_url) {
      return sendJson(res, 200, {
        status: 'done',
        videoUrl,
        downloadUrl: `${videoUrl}?download=1`,
        size: job.size != null ? Number(job.size) : undefined,
        duration: job.duration != null ? Number(job.duration) : undefined,
        resolution: job.resolution || undefined,
        expiresAt: job.expires_at || null
      });
    }

    // المصادر جاهزة؟ (روابط جاهزة دائمًا — الملفات تتطلب اكتمال الأجزاء)
    const sources = await dbm.getSources(id);
    if (!sources.length) return sendError(res, 409, 'لا توجد مصادر لهذه المهمة');
    for (const s of sources) {
      if (s.kind !== 'file') continue;
      const ready = Number(s.uploaded_bytes || 0) > 0 && (!s.size || Number(s.uploaded_bytes) >= Number(s.size));
      if (!ready) return sendError(res, 409, 'المصادر غير مكتملة — أكمل رفع أجزاء الملفات أولًا');
    }

    // ادّعاء ذري: النداءات المتزامنة تفشل هنا → 202
    const claimed = await dbm.claimJob(id);
    if (!claimed) {
      const cur = await dbm.getJob(id);
      if (cur && cur.status === 'processing') return sendJson(res, 202, { status: 'processing' });
      return sendError(res, 409, 'المهمة في حالة لا تسمح بالمعالجة');
    }

    try {
      // التقدم: 0–40 سحب، 40–90 ترميز (من داخل merge)، 100 عند الاكتمال
      const result = await merge.mergeJob(id, async (pct) => {
        await dbm.updateJob(id, {
          progress: Math.max(0, Math.min(99, Number(pct) || 0)),
          updated_at: nowIso()
        });
      });
      await dbm.updateJob(id, {
        status: 'done',
        progress: 100,
        error: null,
        video_url: videoUrl,
        size: result.size,
        duration: result.duration,
        resolution: result.resolution,
        updated_at: nowIso()
      });
      return sendJson(res, 200, {
        status: 'done',
        videoUrl,
        downloadUrl: `${videoUrl}?download=1`,
        size: result.size,
        duration: result.duration,
        resolution: result.resolution,
        expiresAt: job.expires_at || null
      });
    } catch (e) {
      const msg = (e && e.message) ? e.message : 'فشل دمج الفيديو';
      await dbm.updateJob(id, { status: 'failed', error: msg, updated_at: nowIso() }).catch(() => {});
      return sendError(res, 500, msg);
    }
  } catch (e) {
    console.error('[process] خطأ خارجي:', e && e.stack || e); // تسجيل الخطأ الحقيقي أثناء التطوير
    return sendError(res, 500, 'خطأ داخلي في الخادم');
  }
};
