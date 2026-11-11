'use strict';
/* GET /api/cron — حذف كل المهام التي انتهت صلاحيتها (expires_at < الآن) من كل الجداول
   تُستدعى تلقائيًا من Vercel Cron (0 2 * * *) حسب vercel.json */

require('dotenv').config();
const { sendJson, sendError, handleOptions } = require('../lib/util');
const dbm = require('../lib/db');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return sendError(res, 405, 'طريقة غير مسموحة');
  try {
    await dbm.ensureSchema();
    const deleted = await dbm.cleanupExpired();
    return sendJson(res, 200, { deleted });
  } catch (_) {
    return sendError(res, 500, 'تعذر تنفيذ التنظيف');
  }
};
