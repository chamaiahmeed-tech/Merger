'use strict';
/* GET  /api/jobs/<id> — الحالة + التقدم (0–100) + الرابط عند الاكتمال
   DELETE /api/jobs/<id> — حذف فوري شامل لكل صفوف المهمة (jobs + sources + source_chunks + output_chunks)
   الحقول الفارغة تُحذف من الاستجابة، و"status" و"progress" موجودان دائمًا */

require('dotenv').config();
const { sendJson, sendError, handleOptions, getOrigin } = require('../../lib/util');
const dbm = require('../../lib/db');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  try {
    await dbm.ensureSchema();
    const id = String((req.query || {}).id || '');
    if (!id) return sendError(res, 400, 'معرف المهمة مفقود');

    if (req.method === 'GET') {
      const job = await dbm.getJob(id);
      if (!job) return sendError(res, 404, 'المهمة غير موجودة');
      const origin = getOrigin(req);
      const out = {
        jobId: job.id,
        status: String(job.status || 'queued'),
        progress: Number(job.progress || 0),
        expiresAt: job.expires_at || null
      };
      if (job.status === 'done') {
        out.videoUrl = `${origin}/api/jobs/${id}/video`;
        out.downloadUrl = `${origin}/api/jobs/${id}/video?download=1`;
        if (job.size != null) out.size = Number(job.size);
        if (job.duration != null) out.duration = Number(job.duration);
        if (job.resolution) out.resolution = job.resolution;
      }
      if (job.status === 'failed') out.error = job.error || 'فشلت المعالجة';
      return sendJson(res, 200, out);
    }

    if (req.method === 'DELETE') {
      const job = await dbm.getJob(id);
      if (!job) return sendError(res, 404, 'المهمة غير موجودة');
      await dbm.deleteJobAll(id); // حذف شامل من كل الجداول
      return sendJson(res, 200, { ok: true });
    }

    return sendError(res, 405, 'طريقة غير مسموحة');
  } catch (_) {
    return sendError(res, 500, 'خطأ داخلي في الخادم');
  }
};
