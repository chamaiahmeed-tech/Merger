'use strict';
/* POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
   upsert لصف الجزء، إعادة حساب uploaded_bytes من SUM(LENGTH(data))،
   ورفع 413 عند تجاوز حد حجم المصدر، و409 إذا كانت المهمة في مرحلة لا تقبل الرفع */

require('dotenv').config();
const { sendJson, sendError, handleOptions, readRawBody, UPLOAD_CHUNK_BYTES } = require('../lib/util');
const dbm = require('../lib/db');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return sendError(res, 405, 'طريقة غير مسموحة');
  try {
    await dbm.ensureSchema();
    const q = req.query || {};
    const jobId = String(q.job || '');
    const seq = parseInt(q.seq, 10);
    const chunk = parseInt(q.chunk, 10);
    if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
      return sendError(res, 400, 'معاملات الرفع غير صحيحة');
    }
    const job = await dbm.getJob(jobId);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة');
    if (job.status === 'processing' || job.status === 'done') {
      return sendError(res, 409, 'لا يمكن رفع الأجزاء في هذه المرحلة');
    }
    const src = await dbm.getSource(jobId, seq);
    if (!src) return sendError(res, 404, 'المصدر غير موجود');

    const body = await readRawBody(req);
    if (!body || !body.length) return sendError(res, 400, 'الجزء المرفوع فارغ');
    if (body.length > UPLOAD_CHUNK_BYTES) return sendError(res, 413, 'حجم الجزء يتجاوز 4MB');

    const sourceMaxBytes = (parseInt(process.env.SOURCE_MAX_MB || '200', 10) || 200) * 1024 * 1024;
    const existing = await dbm.getSourceUploadedBytes(jobId, seq);
    if (existing + body.length > sourceMaxBytes) {
      return sendError(res, 413, 'حجم الملف يتجاوز الحد المسموح');
    }

    await dbm.upsertSourceChunk(jobId, seq, chunk, body);
    const totalBytes = await dbm.getSourceUploadedBytes(jobId, seq); // دقيق حتى مع إعادة رفع نفس الجزء
    await dbm.updateSourceUploadedBytes(jobId, seq, totalBytes);
    if (job.status !== 'uploading') {
      await dbm.updateJob(jobId, { status: 'uploading', updated_at: new Date().toISOString() });
    }

    return sendJson(res, 200, {
      ok: true,
      job: jobId,
      seq,
      chunk,
      received: body.length,
      uploadedBytes: totalBytes,
      completed: !!(src.size && totalBytes >= Number(src.size))
    });
  } catch (e) {
    if (e && e.status) return sendError(res, e.status, e.message);
    return sendError(res, 500, 'تعذر رفع الجزء');
  }
};
