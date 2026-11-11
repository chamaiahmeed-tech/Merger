'use strict';
/* POST /api/jobs — إنشاء مهمة دمج.
   يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{kind:"url",url:...},{kind:"file",name,size,mime}]}
   → 201: {jobId, status, statusUrl, processUrl, expiresAt} + uploads[] عند وجود ملفات
   الرفض: أقل من مصدرين → 400، أكثر من MAX_SOURCES → 400، url غير http/https → 400، JSON تالف → 400 */

require('dotenv').config();
const {
  sendJson, sendError, handleOptions, readJsonBody, getOrigin,
  genId, nowIso, addHours, validateJobSources, UPLOAD_CHUNK_BYTES
} = require('../lib/util');
const dbm = require('../lib/db');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return sendError(res, 405, 'طريقة غير مسموحة');
  try {
    await dbm.ensureSchema();
    try { await dbm.cleanupExpired(); } catch (_) {} // تنظيف كسول عند كل إنشاء

    const body = await readJsonBody(req, 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, 'صيغة الطلب غير صحيحة');
    }

    // الشكلان المقبولان
    let list;
    if (Array.isArray(body.videos)) {
      list = body.videos.map((v) => ({ kind: 'url', url: typeof v === 'string' ? v.trim() : '' }));
    } else if (Array.isArray(body.sources)) {
      list = body.sources.map((s) => {
        if (s && typeof s === 'object' && s.kind === 'file') {
          return {
            kind: 'file',
            name: String(s.name || ''),
            size: Math.max(0, Number(s.size) || 0),
            mime: String(s.mime || 'video/mp4')
          };
        }
        const url = s && typeof s === 'object' ? String(s.url || '') : String(s == null ? '' : s);
        return { kind: 'url', url: url.trim() };
      });
    } else {
      return sendError(res, 400, 'صيغة الطلب غير صحيحة: أرسل videos أو sources');
    }

    const maxSources = Math.max(2, parseInt(process.env.MAX_SOURCES || '10', 10) || 10);
    const invalid = validateJobSources(list, maxSources);
    if (invalid) return sendError(res, 400, invalid);

    const id = genId();
    const createdAt = nowIso();
    const expiresAt = addHours(createdAt, 24); // صلاحية 24 ساعة
    const hasFiles = list.some((s) => s.kind === 'file');
    const status = hasFiles ? 'uploading' : 'queued';

    await dbm.createJob({ id, status, createdAt, expiresAt });
    for (let i = 0; i < list.length; i++) await dbm.insertSource(id, i, list[i]);

    const origin = getOrigin(req);
    const out = {
      jobId: id,
      status,
      statusUrl: `${origin}/api/jobs/${id}`,
      processUrl: `${origin}/api/jobs/${id}/process`,
      expiresAt
    };
    if (hasFiles) {
      // رابط رفع أولي لكل مصدر — يُستبدل رقم الجزء (chunk) عند الرفع الفعلي
      out.uploads = list.map((s, i) => ({
        seq: i,
        kind: s.kind,
        url: `${origin}/api/upload?job=${id}&seq=${i}&chunk=0`
      }));
      out.uploadChunkBytes = UPLOAD_CHUNK_BYTES;
    }
    return sendJson(res, 201, out);
  } catch (e) {
    if (e && e.status) return sendError(res, e.status, e.message);
    return sendError(res, 500, 'تعذر إنشاء المهمة');
  }
};
