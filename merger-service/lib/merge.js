'use strict';
/* محرك الدمج (الأهم):
   - ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت
   - توحيد كل المصادر عبر filter_complex: scale+pad إلى أكبر دقة بين المدخلات
     (حد أقصى 1920×1080 وأبعاد زوجية بتقريب لأسفل)، fps=30، setsar=1، format=yuv420p
     ثم concat=n=:v=1:a=1
   - مصدر بلا صوت → مسار صامت anullsrc=r=44100:cl=stereo مقتطع بنفس مدته (atrim+asetpts)
   - ترميز نهائي: libx264 CRF 18 + AAC 192k/44100 + movflags +faststart
     + preset من FFMPEG_PRESET (افتراضي medium)
   - تقدم الترميز من -progress pipe:1 (out_time_us) مخزّن في القاعدة مباشرة:
     0–40 سحب المصادر، 40–90 ترميز، 100 عند الاكتمال
   - فرض الحدود برسائل عربية واضحة (رمي خطأ وليس انهيار) وتنظيف /tmp في finally */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const dbm = require('./db');
const store = require('./store');
const { arabicError } = require('./util');

const MAX_W = 1920;
const MAX_H = 1080;
const TARGET_FPS = 30;
const AUDIO_RATE = 44100;
const ENCODE_TIMEOUT_MS = 280000; // أقل من maxDuration (300) بهامش للأمان

function envInt(name, def) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/* ffmpeg-static يعيد مسارًا نصيًا وffprobe-static يعيد {path} */
function ffprobeBin() {
  const mod = ffprobeStatic;
  const p = mod && typeof mod === 'object' ? mod.path : mod;
  return p || 'ffprobe';
}

/* نسخ الثنائي إلى /tmp بصلاحية 755 إذا لم يكن قابلًا للتنفيذ
   (نظام ملفات القراءة فقط في بيئة السيرفرلس) */
async function ensureExecutable(binPath) {
  if (!binPath) throw arabicError('ثنائي ffmpeg غير متوفر في البيئة', 500);
  try { fs.accessSync(binPath, fs.constants.X_OK); return binPath; } catch (_) {}
  const dest = path.join(os.tmpdir(), path.basename(binPath));
  try {
    fs.accessSync(dest, fs.constants.X_OK); // نسخة سابقة صالحة — أعد استخدامها
    return dest;
  } catch (_) {}
  await fs.promises.copyFile(binPath, dest);
  await fs.promises.chmod(dest, 0o755);
  return dest;
}

/* غلاف ffprobe: يرجع {width,height,duration,fps,hasAudio} */
function probe(bin, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => reject(arabicError('تعذر تشغيل ffprobe', 500)));
    p.on('close', (code) => {
      if (code !== 0) return reject(arabicError('تعذر تحليل أحد المقاطع (ملف فيديو غير صالح؟)', 500));
      try {
        const info = JSON.parse(out);
        const vs = (info.streams || []).find((s) => s.codec_type === 'video');
        const as = (info.streams || []).find((s) => s.codec_type === 'audio');
        if (!vs || !vs.width || !vs.height) return reject(arabicError('أحد المقاطع لا يحتوي مسار فيديو صالح', 500));
        const dur = parseFloat(vs.duration || (info.format && info.format.duration) || '0') || 0;
        const parts = String(vs.r_frame_rate || '30/1').split('/');
        const fps = parts.length === 2 && Number(parts[1]) ? Number(parts[0]) / Number(parts[1]) : TARGET_FPS;
        resolve({ width: vs.width, height: vs.height, duration: dur, fps, hasAudio: !!as });
      } catch (_) {
        reject(arabicError('تعذر قراءة ناتج ffprobe', 500));
      }
    });
  });
}

/* تشغيل ffmpeg مع قراءة out_time_us من stdout (-progress pipe:1)
   وحساب النسبة من المدة الإجمالية → تقرير 40..90 إلى القاعدة */
function runFfmpeg(bin, args, totalDuration, report) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let errText = '';
    let lastPct = 39;
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (_) {}
      reject(arabicError('استغرقت عملية الدمج وقتًا أطول من المسموح', 500));
    }, ENCODE_TIMEOUT_MS);
    p.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        // ملاحظة: ffmpeg يعيد out_time_ms بالميكروثانية رغم الاسم — كلاهما يعامل بالمثل
        const m = /^out_time_us=(\d+)/.exec(line) || /^out_time_ms=(\d+)/.exec(line);
        if (m && totalDuration > 0) {
          const sec = Number(m[1]) / 1e6;
          const pct = Math.max(40, Math.min(90, 40 + Math.floor((sec / totalDuration) * 50)));
          if (pct > lastPct) {
            lastPct = pct;
            Promise.resolve(report(pct)).catch(() => {});
          }
        }
      }
    });
    p.stderr.on('data', (d) => {
      errText += d.toString();
      if (errText.length > 8000) errText = errText.slice(-4000);
    });
    p.on('error', () => { clearTimeout(timer); reject(arabicError('تعذر تشغيل ffmpeg', 500)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(arabicError('فشل ترميز الفيديو' + (errText.trim() ? ': ' + errText.trim().slice(0, 300) : ''), 500));
    });
  });
}

/* الدمج الكامل لمهمة موجودة في القاعدة — يرجع {size,duration,resolution} */
async function mergeJob(jobId, onProgress) {
  const report = onProgress || (async () => {});
  await dbm.ensureSchema();

  const sources = await dbm.getSources(jobId);
  if (sources.length < 2) throw arabicError('يلزم مقطعان على الأقل للدمج', 409);
  const maxSources = envInt('MAX_SOURCES', 10);
  if (sources.length > maxSources) throw arabicError(`أقصى عدد مقاطع هو ${maxSources}`, 413);

  const sourceMaxBytes = envInt('SOURCE_MAX_MB', 200) * 1024 * 1024;
  const outputMaxBytes = envInt('OUTPUT_MAX_MB', 150) * 1024 * 1024;
  const maxTotalDuration = envInt('MAX_TOTAL_DURATION_SEC', 600);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${jobId}-`));
  try {
    const ffmpegBin = await ensureExecutable(ffmpegStatic);
    const ffBin = await ensureExecutable(ffprobeBin());

    // ===== المرحلة 0–40: سحب المصادر إلى /tmp مع عدّ البايتات وتحليلها =====
    const files = [];
    const infos = [];
    let totalDuration = 0;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src-${i}.bin`);
      if (s.kind === 'url') {
        await store.downloadUrlSource(s.url, dest, sourceMaxBytes);
      } else {
        const bytes = await store.reconstructSourceFile(jobId, i, dest);
        if (!bytes) throw arabicError('أحد المقاطع المرفوعة فارغ أو غير مكتمل', 409);
      }
      const size = fs.statSync(dest).size;
      if (size > sourceMaxBytes) throw arabicError('حجم أحد المقاطع يتجاوز الحد المسموح', 413);
      const info = await probe(ffBin, dest);
      if (!(info.duration > 0)) throw arabicError('تعذر تحديد مدة أحد المقاطع', 500);
      totalDuration += info.duration;
      if (totalDuration > maxTotalDuration) {
        throw arabicError(`المدة الكلية للمقاطع تتجاوز الحد المسموح (${maxTotalDuration} ثانية)`, 413);
      }
      files.push(dest);
      infos.push(info);
      await report(Math.round(((i + 1) / sources.length) * 40));
    }

    // أكبر دقة بين المدخلات مع حد 1920×1080 وأبعاد زوجية (تقريب لأسفل)
    let W = Math.min(Math.max(...infos.map((x) => x.width)), MAX_W);
    let H = Math.min(Math.max(...infos.map((x) => x.height)), MAX_H);
    W -= W % 2;
    H -= H % 2;
    if (W < 2 || H < 2) throw arabicError('أبعاد المقاطع غير صالحة للدمج', 415);

    // ===== بناء filter_complex: scale+pad + fps + setsar + yuv420p ثم concat =====
    const inputArgs = [];
    for (const f of files) inputArgs.push('-i', f);
    let inputCount = sources.length;
    const silentInput = {};
    for (let i = 0; i < infos.length; i++) {
      if (!infos[i].hasAudio) {
        // مصدر بلا صوت → إدخال anullsrc صامت مقتطع بنفس مدته بدل أن يفشل الدمج
        inputArgs.push('-f', 'lavfi', '-i', `anullsrc=r=${AUDIO_RATE}:cl=stereo`);
        silentInput[i] = inputCount++;
      }
    }

    const parts = [];
    for (let i = 0; i < infos.length; i++) {
      parts.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},setsar=1,format=yuv420p[v${i}]`
      );
      if (infos[i].hasAudio) {
        parts.push(`[${i}:a]aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        parts.push(`[${silentInput[i]}:a]atrim=0:${infos[i].duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      }
    }
    parts.push(infos.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${infos.length}:v=1:a=1[vout][aout]`);
    const filter = parts.join(';');

    // ===== المرحلة 40–90: الترميز النهائي =====
    const outPath = path.join(tmpDir, 'out.mp4');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-crf', '18', '-preset', String(process.env.FFMPEG_PRESET || 'medium'),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE),
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      outPath
    ];
    await runFfmpeg(ffmpegBin, args, totalDuration, report);

    const outStat = fs.statSync(outPath);
    if (outStat.size > outputMaxBytes) {
      throw arabicError(`حجم الفيديو الناتج يتجاوز الحد المسموح (${envInt('OUTPUT_MAX_MB', 150)}MB)`, 413);
    }

    // ===== حفظ الناتج: Blob على صفوف 2MB ثم حذف أجزاء المصادر =====
    const outInfo = await probe(ffBin, outPath);
    const data = fs.readFileSync(outPath);
    await dbm.writeOutputBlob(jobId, data);
    await dbm.deleteSourceChunks(jobId);

    return {
      size: outStat.size,
      duration: Math.round((outInfo.duration || totalDuration) * 100) / 100,
      resolution: `${outInfo.width}x${outInfo.height}`
    };
  } finally {
    // تنظيف /tmp دائمًا — لا نظام ملفات دائم
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { mergeJob, ensureExecutable, probe, runFfmpeg, ffprobeBin };
