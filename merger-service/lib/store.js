'use strict';
/* تجميع المصادر والناتج:
   - reconstructSourceFile: إعادة بناء ملف مرفوع من صفوف source_chunks إلى /tmp
   - downloadUrlSource: تنزيل مصدر رابط إلى /tmp مع عدّ البايتات ورفض تجاوز الحد برسالة عربية
   - createOutputRangeStream: قارئ تدفقي لصفوف output_chunks (صفحات من 8 صفوف)
     مع تقليم أول/آخر جزء حسب المدى المطلوب → Node Readable يدعم Range */

require('dotenv').config();
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const dbm = require('./db');
const { arabicError, BLOB_PAGE_ROWS } = require('./util');

function toBuffer(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

/* إعادة بناء مصدر مرفوع من أجزاء القاعدة إلى ملف في /tmp — يرجع الحجم بالبايت */
async function reconstructSourceFile(jobId, seq, destPath) {
  let offset = 0;
  const fd = fs.openSync(destPath, 'w');
  try {
    while (true) {
      const r = await dbm.db().execute({
        sql: 'SELECT data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk ASC LIMIT ? OFFSET ?',
        args: [jobId, seq, BLOB_PAGE_ROWS, offset]
      });
      if (!r.rows.length) break;
      for (const row of r.rows) fs.writeSync(fd, toBuffer(row.data));
      if (r.rows.length < BLOB_PAGE_ROWS) break;
      offset += BLOB_PAGE_ROWS;
    }
  } finally {
    fs.closeSync(fd);
  }
  return fs.statSync(destPath).size;
}

/* تنزيل مصدر URL إلى /tmp مع عدّ البايتات أثناء التدفق — تجاوز الحد = فشل عربي واضح */
async function downloadUrlSource(url, destPath, maxBytes) {
  let res;
  try { res = await fetch(url); }
  catch (_) { throw arabicError('تعذر تنزيل أحد المصادر — تحقق من الرابط', 502); }
  if (!res.ok) throw arabicError(`تعذر تنزيل أحد المصادر (رمز الاستجابة ${res.status})`, 502);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    try { await res.body.cancel(); } catch (_) {}
    throw arabicError('حجم أحد المقاطع يتجاوز الحد المسموح', 413);
  }
  let count = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      count += chunk.length;
      if (count > maxBytes) {
        cb(arabicError('حجم أحد المقاطع يتجاوز الحد المسموح', 413));
        return;
      }
      cb(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
  } catch (e) {
    if (e && e.arabic) throw e; // خطأ الحد يمرّ برسالته العربية كما هو
    throw arabicError('فشل تنزيل أحد المصادر أثناء النقل', 502);
  }
  return count;
}

/* Readable يبث ناتج الدمج من صفوف output_chunks مع تقليم المدى [start..end]
   يعتمد على أن start صالح (< الحجم الكلي) — التحقق يتم عند نقطة البث */
function createOutputRangeStream(jobId, start, end) {
  const PAGE = BLOB_PAGE_ROWS;
  let offset = 0;   // إزاحة الصفوف المستردة من القاعدة
  let pos = 0;      // الموضع المنطقي الحالي داخل الملف الكلي

  const it = (async function* fetchRows() {
    while (true) {
      const r = await dbm.db().execute({
        sql: 'SELECT data FROM output_chunks WHERE job_id = ? ORDER BY chunk ASC LIMIT ? OFFSET ?',
        args: [jobId, PAGE, offset]
      });
      if (!r.rows.length) return;
      for (const row of r.rows) yield toBuffer(row.data);
      if (r.rows.length < PAGE) return;
      offset += PAGE;
    }
  })();

  return new Readable({
    async read() {
      try {
        while (true) {
          const { value, done } = await it.next();
          if (done) { this.push(null); return; }
          const buf = value;
          const from = Math.max(0, start - pos);                 // تجاوز ما قبل المدى
          const to = Math.min(buf.length, end + 1 - pos);        // قصّ ما بعد المدى
          pos += buf.length;
          if (to > from) {
            const piece = buf.subarray(from, to);
            if (piece.length) this.push(piece);
          }
          if (pos > end) { this.push(null); return; }            // اكتمل المدى
          if (to > from) return;                                 // احترام الضغط العكسي
        }
      } catch (e) {
        this.destroy(e);
      }
    }
  });
}

module.exports = {
  reconstructSourceFile,
  downloadUrlSource,
  createOutputRangeStream
};
