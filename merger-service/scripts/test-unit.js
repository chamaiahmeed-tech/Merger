'use strict';
/* اختبارات وحدة (تُشغَّل لاحقًا في مرحلة أخرى مع .env مضبوط):
   1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (320x240 مع صوت sine 3 ثوانٍ، و640x360 مع صوت 4 ثوانٍ)
   2) إنشاء صفوف jobs/sources في القاعدة ثم الدمج عبر lib/merge مباشرة والتحقق:
      اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد (±1.5s)، وجود الصوت (ffprobe)
   3) تخزين Blob في Turso واسترجاعه بتطابق sha256 (+ تقليم مدى داخلي)
   4) مسار رفع الأجزاء (store): إعادة بناء بتطابق sha256
   5) رفض أكثر من MAX_SOURCES عبر الدوال الداخلية
   6) الحذف الشامل من كل الجداول
   يطبع "PASS name" / "FAIL name: reason" لكل اختبار وسطر نهائي "UNIT: X/Y passed". */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

const dbm = require('../lib/db');
const store = require('../lib/store');
const merge = require('../lib/merge');
const { validateJobSources } = require('../lib/util');

const results = [];
function ok(name) { results.push(true); console.log('PASS ' + name); }
function fail(name, reason) { results.push(false); console.log('FAIL ' + name + ': ' + reason); }

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/* أمر ffmpeg/ffprobe المتاح في PATH يكفي للاختبار — وإن لم يوجد جرّب الحزم المرفقة */
function resolveFfmpeg() {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch (_) {}
  return null;
}
function resolveFfprobe() {
  if (spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffprobe';
  try { const p = require('ffprobe-static'); if (p && p.path && fs.existsSync(p.path)) return p.path; } catch (_) {}
  return null;
}

function genVideo(bin, out, size, dur, freq) {
  const r = spawnSync(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=${dur}`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`,
    '-t', String(dur), '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
    out
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr.toString().slice(0, 300));
}

async function collect(readable) {
  const parts = [];
  for await (const c of readable) parts.push(c);
  return Buffer.concat(parts);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-tests-'));
  let ff = resolveFfmpeg();
  let fp = resolveFfprobe();
  if (ff && ff !== 'ffmpeg') ff = await merge.ensureExecutable(ff);
  if (fp && fp !== 'ffprobe') fp = await merge.ensureExecutable(fp);

  await dbm.ensureSchema();
  const created = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  /* ====== تجهيز مهمة الدمج: مصدران مختلفا الدقة مرفوعان كأجزاء (يمرّ عبر مسار store) ====== */
  const jobId = 'ut' + crypto.randomBytes(8).toString('hex');
  await dbm.createJob({ id: jobId, status: 'uploading', createdAt: created, expiresAt });

  let mergeResult = null;
  try {
    if (!ff) {
      fail('merge-complete', 'ffmpeg غير متاح في PATH ولا عبر ffmpeg-static');
    } else {
      const f1 = path.join(tmp, 'a.mp4');
      const f2 = path.join(tmp, 'b.mp4');
      genVideo(ff, f1, '320x240', 3, 440);
      genVideo(ff, f2, '640x360', 4, 660);

      await dbm.insertSource(jobId, 0, { kind: 'file', name: 'a.mp4', size: fs.statSync(f1).size, mime: 'video/mp4' });
      await dbm.insertSource(jobId, 1, { kind: 'file', name: 'b.mp4', size: fs.statSync(f2).size, mime: 'video/mp4' });

      // رفع أجزاء (128KB لكل جزء — أكبر من ملفات الاختبار عادة فتتعدد الصفوف)
      const CHUNK = 128 * 1024;
      for (const pair of [[0, f1], [1, f2]]) {
        const seq = pair[0];
        const buf = fs.readFileSync(pair[1]);
        const n = Math.ceil(buf.length / CHUNK);
        for (let k = 0; k < n; k++) {
          await dbm.upsertSourceChunk(jobId, seq, k, buf.subarray(k * CHUNK, Math.min(buf.length, (k + 1) * CHUNK)));
        }
        await dbm.updateSourceUploadedBytes(jobId, seq, buf.length);
      }

      // الدمج مباشرة عبر lib/merge
      mergeResult = await merge.mergeJob(jobId);
      ok('merge-complete');
    }
  } catch (e) {
    fail('merge-complete', e.message);
  }

  if (mergeResult) {
    // الدقة = أكبر دقة مدخل
    if (mergeResult.resolution === '640x360') ok('merge-resolution');
    else fail('merge-resolution', `الناتج ${mergeResult.resolution} والمتوقع 640x360`);

    // المدة ≈ 3 + 4 = 7 ثوانٍ بهامش ±1.5s
    if (Math.abs(mergeResult.duration - 7) <= 1.5) ok('merge-duration');
    else fail('merge-duration', `المدة ${mergeResult.duration} والمتوقع ≈ 7`);

    // وجود الصوت (ffprobe على الناتج المسترجع من القاعدة)
    try {
      if (!fp) throw new Error('ffprobe غير متاح');
      const total = await dbm.getOutputSize(jobId);
      const outFile = path.join(tmp, 'out.mp4');
      await pipeline(store.createOutputRangeStream(jobId, 0, total - 1), fs.createWriteStream(outFile));
      const info = await merge.probe(fp, outFile);
      if (info.hasAudio) ok('merge-audio');
      else fail('merge-audio', 'لا يوجد مسار صوتي في الناتج');
    } catch (e) {
      fail('merge-audio', e.message);
    }
  } else {
    fail('merge-resolution', 'تخطي — الدمج لم يكتمل');
    fail('merge-duration', 'تخطي — الدمج لم يكتمل');
    fail('merge-audio', 'تخطي — الدمج لم يكتمل');
  }

  /* ====== تخزين Blob واسترجاعه بتطابق sha256 + تقليم مدى ====== */
  try {
    const blobJob = 'ub' + crypto.randomBytes(8).toString('hex');
    await dbm.createJob({ id: blobJob, status: 'done', createdAt: created, expiresAt });
    const rnd = crypto.randomBytes(5 * 1024 * 1024 + 137); // حجم غير دوري عبر حدود الصفوف 2MB
    await dbm.writeOutputBlob(blobJob, rnd);
    const full = await collect(store.createOutputRangeStream(blobJob, 0, rnd.length - 1));
    const sliced = await collect(store.createOutputRangeStream(blobJob, 100, 999));
    await dbm.deleteJobAll(blobJob);
    if (full.length === rnd.length && sha256(full) === sha256(rnd) && sliced.equals(rnd.subarray(100, 1000))) {
      ok('blob-sha256');
    } else {
      fail('blob-sha256', 'المحتوى المسترجع لا يطابق الأصل');
    }
  } catch (e) {
    fail('blob-sha256', e.message);
  }

  /* ====== مسار رفع الأجزاء (store): إعادة بناء بتطابق sha256 ====== */
  try {
    const upJob = 'uu' + crypto.randomBytes(8).toString('hex');
    await dbm.createJob({ id: upJob, status: 'uploading', createdAt: created, expiresAt });
    await dbm.insertSource(upJob, 0, { kind: 'file', name: 'x.bin', size: 0, mime: 'video/mp4' });
    const rnd = crypto.randomBytes(1024 * 1024 + 321);
    const CHUNK = 100 * 1024;
    const n = Math.ceil(rnd.length / CHUNK);
    for (let k = 0; k < n; k++) {
      await dbm.upsertSourceChunk(upJob, 0, k, rnd.subarray(k * CHUNK, Math.min(rnd.length, (k + 1) * CHUNK)));
    }
    const dest = path.join(tmp, 'rebuilt.bin');
    const bytes = await store.reconstructSourceFile(upJob, 0, dest);
    const got = fs.readFileSync(dest);
    await dbm.deleteJobAll(upJob);
    if (bytes === rnd.length && sha256(got) === sha256(rnd)) ok('upload-chunks-path');
    else fail('upload-chunks-path', 'الملف المُعاد بناؤه لا يطابق الأصل');
  } catch (e) {
    fail('upload-chunks-path', e.message);
  }

  /* ====== رفض أكثر من MAX_SOURCES عبر الدوال الداخلية ====== */
  try {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ kind: 'url', url: 'https://example.com/v' + i + '.mp4' }));
    const err = validateJobSources(eleven, 10);
    const two = validateJobSources(eleven.slice(0, 2), 10);
    if (err && err.indexOf('أقصى عدد مقاطع هو 10') !== -1 && two === null) ok('max-sources-reject');
    else fail('max-sources-reject', 'النتيجة: ' + JSON.stringify({ err, two }));
  } catch (e) {
    fail('max-sources-reject', e.message);
  }

  /* ====== الحذف الشامل من كل الجداول ====== */
  try {
    const delJob = 'ud' + crypto.randomBytes(8).toString('hex');
    await dbm.createJob({ id: delJob, status: 'uploading', createdAt: created, expiresAt });
    await dbm.insertSource(delJob, 0, { kind: 'file', name: 'y.bin', size: 0, mime: 'video/mp4' });
    await dbm.upsertSourceChunk(delJob, 0, 0, Buffer.from('hello-blob'));
    await dbm.writeOutputBlob(delJob, Buffer.alloc(4096, 7));
    const n = await dbm.deleteJobAll(delJob);
    const goneJob = !(await dbm.getJob(delJob));
    const goneChunks = (await dbm.countSourceChunks(delJob, 0)) === 0;
    const goneOut = (await dbm.getOutputSize(delJob)) === 0;
    if (n === 1 && goneJob && goneChunks && goneOut) ok('delete-all');
    else fail('delete-all', JSON.stringify({ n, goneJob, goneChunks, goneOut }));
  } catch (e) {
    fail('delete-all', e.message);
  }

  /* ====== تنظيف مهمة الدمج وملفات /tmp ====== */
  try { await dbm.deleteJobAll(jobId); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  const passed = results.filter(Boolean).length;
  console.log(`UNIT: ${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => {
  console.log('FAIL setup: ' + (e && e.message));
  const passed = results.filter(Boolean).length;
  console.log(`UNIT: ${passed}/${results.length} passed`);
  process.exitCode = 1;
});
