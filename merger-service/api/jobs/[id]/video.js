'use strict';
/* GET /api/jobs/<id>/video — بث الناتج MP4:
   - Range إلزامي دعمه: 206 + Content-Range: bytes start-end/total + Accept-Ranges: bytes
   - بدون Range → 200 كامل
   - ?download=1 → Content-Disposition: attachment
   - القراءة تدفقية من صفوف output_chunks (صفحات من 8 صفوف) مع تقليم المدى */

require('dotenv').config();
const { applyCors, sendError, handleOptions } = require('../../../lib/util');
const dbm = require('../../../lib/db');
const store = require('../../../lib/store');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  applyCors(res);
  if (req.method !== 'GET') return sendError(res, 405, 'طريقة غير مسموحة');
  try {
    await dbm.ensureSchema();
    const q = req.query || {};
    const id = String(q.id || '');
    if (!id) return sendError(res, 400, 'معرف المهمة مفقود');

    const job = await dbm.getJob(id);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة');
    if (job.status !== 'done') return sendError(res, 409, 'الفيديو غير جاهز بعد');
    const total = await dbm.getOutputSize(id);
    if (!total) return sendError(res, 404, 'لا يوجد فيديو محفوظ لهذه المهمة');

    // download=1 من req.query (Vercel/dev-server) أو من رابط الطلب
    let download = q.download === '1' || q.download === 1;
    if (!download) {
      try { download = new URL(req.url, 'http://x').searchParams.get('download') === '1'; } catch (_) {}
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    if (download) res.setHeader('Content-Disposition', `attachment; filename="merged-${id}.mp4"`);

    let start = 0;
    let end = total - 1;
    let isRange = false;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (!m) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return sendError(res, 416, 'نطاق البايتات غير صالح');
      }
      isRange = true;
      if (m[1] === '') {
        // لاحقة: bytes=-N (آخر N بايت)
        const suffix = parseInt(m[2], 10) || 0;
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
      }
      if (!Number.isInteger(start) || start < 0 || start > end || start >= total) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return sendError(res, 416, 'نطاق البايتات غير صالح');
      }
    }

    const length = end - start + 1;
    res.statusCode = isRange ? 206 : 200;
    if (isRange) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(length));

    const stream = store.createOutputRangeStream(id, start, end);
    stream.on('error', () => { try { res.destroy(); } catch (_) {} });
    stream.pipe(res);
  } catch (_) {
    if (!res.headersSent) return sendError(res, 500, 'خطأ داخلي في الخادم');
    try { res.destroy(); } catch (_) {}
  }
};
