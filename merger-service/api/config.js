'use strict';
/* GET /api/config — الحدود العامة ورقم الإصدار */

require('dotenv').config();
const { sendJson, sendError, handleOptions } = require('../lib/util');

function envInt(name, def) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

module.exports = (req, res) => {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return sendError(res, 405, 'طريقة غير مسموحة');
  return sendJson(res, 200, {
    version: '1.0.0',
    maxSources: envInt('MAX_SOURCES', 10),
    sourceMaxMB: envInt('SOURCE_MAX_MB', 200),
    outputMaxMB: envInt('OUTPUT_MAX_MB', 150),
    maxTotalDurationSec: envInt('MAX_TOTAL_DURATION_SEC', 600),
    uploadChunkBytes: 4194304, // 4MB
    blobChunkBytes: 2097152    // 2MB
  });
};
