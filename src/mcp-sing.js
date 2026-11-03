// 唱歌 / AI 翻唱 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 目标：她说「给我唱《XXX》」时，自己能完成
//   联网找歌 → 下载音源 → 截最多 60 秒 → （后续）人声分离 + RVC 换成她的音色 → 放进语音库 → qq_send_voice 发出去。
//
// 当前阶段：
//   - sing_search / sing_cover(mode=original)：只用 yt-dlp + ffmpeg，已经可用。
//   - mode=ai（真·翻唱）：需要 D:\qq-bridge\sing\venv 里的 torch/demucs/RVC 与她的声音模型，
//     缺哪样就在错误里点名，不静默降级成原唱。
//
// 设计约束（与 android / video 两个 server 一致）：
// - 只写 sing/work 与语音库目录，不碰其它本机文件。
// - 下载一律走 yt-dlp（B站优先，YouTube 兜底），不自己拼流媒体地址。
// - 产出文件名固定 sing- 前缀 + 清理过的标题，方便她在语音库里认。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const exec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SING_DIR = path.join(ROOT, 'sing');
const WORK_DIR = path.join(SING_DIR, 'work');
const VENV_DIR = path.join(SING_DIR, 'venv');
const VENV_PY = path.join(VENV_DIR, 'Scripts', 'python.exe');
const RVC_DIR = path.join(SING_DIR, 'rvc_cli');
const COVER_SCRIPT = path.join(SING_DIR, 'cover.py');
const AI_VOICE_MODEL = path.join(SING_DIR, 'model', 'liuying.pth');
const SPEAK_SCRIPT = path.join(SING_DIR, 'speak.py');
const DEMUCS_MODEL = 'htdemucs';
// 外部工具定位：环境变量 → 技能包约定的固定位置 → 自己扫 PATH（拿到绝对路径）。
// DSH spawn MCP 时不保证继承用户级环境变量，所以只认 env 会在装好 PATH 的机器上误报「找不到」。
function resolveBin(envName, fixed, bare) {
  const fromEnv = process.env[envName];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (fs.existsSync(fixed)) return fixed;
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    const p = dir && path.join(dir.trim(), bare);
    if (p && fs.existsSync(p)) return p;
  }
  return bare; // 交给子进程 PATH 兜底
}
const YTDLP = resolveBin('DSH_YTDLP', path.join(ROOT, 'video', 'venv', 'Scripts', 'yt-dlp.exe'), 'yt-dlp.exe');
const FFMPEG = resolveBin('DSH_FFMPEG', path.join(ROOT, 'video', 'bin', 'ffmpeg.exe'), 'ffmpeg.exe');
const MAX_SECONDS = 240;
/** 不传 seconds 时的默认长度；上限仍是 MAX_SECONDS。 */
const DEFAULT_SECONDS = 30;

// B站反爬（HTTP 412）时需要登录态 cookie。约定放这一个文件：sing\cookies.txt
// 格式是 Netscape cookies.txt（浏览器扩展导出），yt-dlp 能直接吃。
const COOKIES = path.join(SING_DIR, 'cookies.txt');

/** yt-dlp 用的 cookie 参数；没有文件就不加，行为和以前一致。 */
function cookieArgs() {
  return fs.existsSync(COOKIES) ? ['--cookies', COOKIES] : [];
}

/**
 * 从 cookies.txt 里挑出 bilibili.com 的 key=value，给 B站搜索接口当 Cookie 头。
 * Netscape 格式每行 7 列：domain / flag / path / secure / expiry / name / value；
 * 以 #HttpOnly_ 开头的行是有效数据（只是标记 HttpOnly），不能当注释跳过。
 */
function biliCookieHeader() {
  if (!fs.existsSync(COOKIES)) return '';
  const pairs = [];
  for (const line of fs.readFileSync(COOKIES, 'utf8').split(/\r?\n/)) {
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const cols = line.split('\t');
    if (cols.length < 7 || !String(cols[0]).includes('bilibili.com')) continue;
    pairs.push(`${cols[5]}=${cols[6]}`);
  }
  return pairs.join('; ');
}

function readConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function voiceDir() {
  const cfg = readConfig();
  const dir = String(cfg.socialV2?.voice?.dir || 'audio');
  return path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
}

async function run(file, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, {
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...opts,
    });
    return String(stdout ?? '');
  } catch (error) {
    const detail = String(error?.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new Error(`${path.basename(file)} 执行失败：${error?.message ?? error}${detail ? `（${detail}）` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 标题/文件名清理：保留中英文数字，其它压成 -，限长 40。 */
function slugify(text) {
  return String(text ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/[^\p{Script=Han}\p{L}\p{N}._ -]+/gu, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'song';
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** 语音库里不重名的目标路径。 */
function uniqueVoicePath(name) {
  const dir = voiceDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

/**
 * 用 yt-dlp 搜歌。B站优先（中文歌命中率最高），失败再退 YouTube。
 * @returns {Promise<{title:string,url:string,duration?:number,source:string,uploader?:string}[]>}
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function stripTags(text) {
  return String(text ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
}

/** "1:57" / "61:8" / "1:02:03" → 秒。 */
function parseClock(text) {
  const parts = String(text ?? '').split(':');
  if (!parts.length || parts.some((p) => p === '' || Number.isNaN(Number(p)))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/**
 * B站公开搜索接口。平时不需要 cookie，但被反爬时（HTTP 412）必须带上登录态。
 * yt-dlp 的 bilisearch 走的是网页搜索，更容易被 412；这个接口更适合当主搜索源。
 */
async function searchBilibili(query, limit) {
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page=1`;
  const cookie = biliCookieHeader();
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`B站搜索接口 HTTP ${res.status}${cookie ? '' : '（未配置 sing\\cookies.txt，反爬时必 412）'}`);
  }
  const data = await res.json();
  if (data?.code !== 0) throw new Error(`B站搜索接口 code=${data?.code} ${data?.message ?? ''}`);
  return (data?.data?.result ?? [])
    .slice(0, limit)
    .map((item) => ({
      title: stripTags(item.title),
      url: `https://www.bilibili.com/video/${item.bvid}`,
      duration: parseClock(item.duration),
      uploader: item.author ? stripTags(item.author) : undefined,
      source: 'bilibili',
    }))
    .filter((item) => item.title && item.url);
}

async function searchSongs(query, limit = 5) {
  const errors = [];
  try {
    const hits = await searchBilibili(query, limit);
    if (hits.length) return hits;
  } catch (error) {
    errors.push(`bilibili-api: ${error?.message ?? error}`);
  }
  const attempts = [
    { prefix: `bilisearch${limit}:`, source: 'bilibili' },
    { prefix: `ytsearch${limit}:`, source: 'youtube' },
  ];
  for (const attempt of attempts) {
    try {
      // 不用 --flat-playlist：B站搜索的扁平结果只有链接、没有标题和时长。
      const out = await run(YTDLP, [
        '--no-warnings', '--ignore-errors', '-J',
        ...cookieArgs(),
        `${attempt.prefix}${query}`,
      ], { timeout: 120_000 });
      const doc = JSON.parse(out);
      const entries = (doc.entries ?? []).filter(Boolean).map((e) => ({
        title: String(e.fulltitle ?? e.title ?? '').trim(),
        url: String(e.webpage_url ?? e.url ?? '').trim(),
        duration: Number.isFinite(Number(e.duration)) ? Number(e.duration) : undefined,
        uploader: e.uploader ? String(e.uploader) : undefined,
        source: attempt.source,
      })).filter((e) => e.url);
      if (entries.length) return entries;
    } catch (error) {
      errors.push(`${attempt.source}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`搜索失败：${errors.join(' / ') || '没有结果'}`);
}

/** 下载最佳音轨并转成 mp3（只保留音频，不带视频）。 */
async function downloadAudio(url, outBase) {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  await run(YTDLP, [
    '--no-warnings', '--ignore-errors',
    ...cookieArgs(),
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--ffmpeg-location', path.dirname(FFMPEG),
    '-o', `${outBase}.%(ext)s`,
    '--no-playlist',
    url,
  ], { timeout: 300_000 });
  for (const ext of ['mp3', 'm4a', 'webm', 'opus', 'aac', 'wav']) {
    const candidate = `${outBase}.${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1024) return candidate;
  }
  throw new Error('下载完成但没找到音频文件');
}

/** 截一段。[start, start+seconds)，统一转 44.1k 立体声 mp3。 */
async function cutSegment(srcFile, outFile, startSeconds, seconds) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(Math.max(0, startSeconds)),
    '-t', String(seconds),
    '-i', srcFile,
    '-ar', '44100', '-ac', '2', '-b:a', '192k',
    outFile,
  ], { timeout: 120_000 });
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) throw new Error('裁剪失败：输出为空');
  return outFile;
}

/** 人声/伴奏分离（demucs）。返回 { vocals, instrumental }。 */
async function separateVocals(inputWav, workDir) {
  const outDir = path.join(workDir, 'demucs');
  await run(VENV_PY, ['-m', 'demucs', '-n', DEMUCS_MODEL, '--two-stems=vocals', '-d', 'cuda', '-o', outDir, inputWav], { timeout: 900_000 });
  const base = path.basename(inputWav, path.extname(inputWav));
  const vocals = path.join(outDir, DEMUCS_MODEL, base, 'vocals.wav');
  const instrumental = path.join(outDir, DEMUCS_MODEL, base, 'no_vocals.wav');
  if (!fs.existsSync(vocals) || !fs.existsSync(instrumental)) throw new Error('人声分离失败：没有生成 vocals / no_vocals');
  return { vocals, instrumental };
}

/** 用她的音色跑 RVC 转换。 */
async function convertVoice(inputWav, outWav, pitch = 0) {
  if (!fs.existsSync(COVER_SCRIPT)) throw new Error('缺少 RVC 驱动脚本 sing/cover.py');
  const log = await run(VENV_PY, [COVER_SCRIPT, inputWav, outWav, String(pitch), 'rmvpe'], { timeout: 900_000 });
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 1024) {
    throw new Error(`RVC 转换失败：${String(log).slice(-300)}`);
  }
  return outWav;
}

/** 把她的干声和伴奏混成一条成品。 */
async function mixTracks(vocalsWav, instrumentalWav, outFile, seconds) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', vocalsWav, '-i', instrumentalWav,
    '-filter_complex',
    '[0:a]volume=1.0[v];[1:a]volume=0.72[i];[v][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[out]',
    '-map', '[out]', '-t', String(seconds),
    '-ar', '44100', '-ac', '2', '-b:a', '192k', outFile,
  ], { timeout: 180_000 });
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) throw new Error('混音失败：输出为空');
  return outFile;
}

/** 读音频时长（秒），失败返回 null。 */
async function probeDuration(file) {
  try {
    const out = await run(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], { timeout: 60_000 }).catch((error) => {
      // ffmpeg 把信息写在 stderr，非零退出也要用
      return String(error?.stderr ?? '');
    });
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    return null;
  }
}

/** 环境自检：每个环节缺什么一眼能看到。 */
async function readiness() {
  const checks = {
    ytdlp: { ok: fs.existsSync(YTDLP), path: YTDLP },
    ffmpeg: { ok: fs.existsSync(FFMPEG), path: FFMPEG },
    venv: { ok: fs.existsSync(VENV_PY), path: VENV_PY },
    torch: { ok: false, detail: '未检测' },
    demucs: { ok: false, detail: '未检测' },
    rvc: { ok: fs.existsSync(RVC_DIR), path: RVC_DIR },
    coverScript: { ok: fs.existsSync(COVER_SCRIPT), path: COVER_SCRIPT },
    voiceModel: { ok: fs.existsSync(AI_VOICE_MODEL), path: AI_VOICE_MODEL },
  };
  if (checks.venv.ok) {
    try {
      const out = await run(VENV_PY, ['-c', 'import torch,sys;print(torch.__version__, torch.cuda.is_available())'], { timeout: 60_000 });
      checks.torch = { ok: true, detail: out.trim() };
    } catch (error) {
      checks.torch = { ok: false, detail: String(error?.message ?? error).slice(0, 200) };
    }
    try {
      await run(VENV_PY, ['-c', 'import demucs'], { timeout: 60_000 });
      checks.demucs = { ok: true };
    } catch (error) {
      checks.demucs = { ok: false, detail: '未安装（pip install demucs）' };
    }
  }
  return checks;
}

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

function err(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

const server = new McpServer({ name: 'sing', version: '0.1.0' });

server.tool(
  'sing_probe',
  '检查唱歌链路是否就绪：yt-dlp / ffmpeg / torch(CUDA) / demucs / RVC 工程 / 她的声音模型。要确认「现在能不能真翻唱」时先调这个。',
  {},
  async () => {
    try {
      return json(await readiness());
    } catch (error) {
      return err(`自检失败：${error?.message ?? error}`);
    }
  },
);

server.tool(
  'sing_search',
  '在线搜歌（B站优先，YouTube 兜底），返回候选的标题/时长/链接。想翻唱但不确定是哪一版时，先用它挑一首再调 sing_cover。',
  {
    query: z.string().min(1).max(80).describe('歌名，可带歌手（如「恋爱循环 花泽香菜」）'),
    limit: z.number().int().min(1).max(8).optional().describe('返回几条，默认 5'),
  },
  async ({ query, limit }) => {
    try {
      return json({ query, results: await searchSongs(query, limit ?? 5) });
    } catch (error) {
      return err(`搜歌失败：${error?.message ?? error}`);
    }
  },
);

server.tool(
  'sing_cover',
  '给她「唱」一段歌：联网找歌 → 下载音源 → 截取最多 4 分钟（240 秒） → 放进语音库，返回文件名（之后用 qq_send_voice 发出去）。mode=original 是原唱片段；mode=ai 是用她自己的声音翻唱（需要本地 RVC 与她的声音模型就绪，没就绪会明确报缺什么，不会偷偷退回原唱）。',
  {
    song: z.string().min(1).max(80).describe('歌名，可带歌手'),
    seconds: z.number().int().min(5).max(MAX_SECONDS).optional().describe(`截多长，最长 ${MAX_SECONDS} 秒，默认 ${DEFAULT_SECONDS}`),
    startSeconds: z.number().min(0).max(3600).optional().describe('从第几秒开始截（默认 0；想抓高潮段可以自己估一个）'),
    mode: z.enum(['original', 'ai']).optional().describe('original=原唱片段（默认）；ai=用她的声音翻唱'),
    candidate: z.number().int().min(1).max(8).optional().describe('搜索结果里取第几个（默认 1，可用 sing_search 先看）'),
    pitch: z.number().int().min(-24).max(24).optional().describe('变调（半音）。男声歌要唱成女声一般 +12；默认 0'),
  },
  async ({ song, seconds, startSeconds, mode, candidate, pitch }) => {
    const wantAi = mode === 'ai';
    try {
      if (wantAi) {
        const checks = await readiness();
        const missing = [];
        if (!checks.venv.ok) missing.push('Python venv（sing/venv）');
        if (!checks.torch.ok) missing.push(`PyTorch（${checks.torch.detail ?? '未安装'}）`);
        if (!checks.demucs.ok) missing.push('demucs（人声分离）');
        if (!checks.rvc.ok) missing.push('RVC 推理代码（sing/rvc_cli）');
        if (!checks.coverScript.ok) missing.push('RVC 驱动脚本（sing/cover.py）');
        if (!checks.voiceModel.ok) missing.push('她的声音模型（sing/model/liuying.pth）');
        if (missing.length) {
          return err(`AI 翻唱还没就绪，缺少：${missing.join('、')}。可以先用 mode=original 发原唱片段，或者让我继续把环境装完。`);
        }
      }
      const length = Math.min(seconds ?? DEFAULT_SECONDS, MAX_SECONDS);
      const results = await searchSongs(song, 5);
      const picked = results[Math.max(0, Math.min((candidate ?? 1) - 1, results.length - 1))];
      if (!picked) throw new Error('没有搜到可用结果');
      await fsp.mkdir(WORK_DIR, { recursive: true });
      const base = path.join(WORK_DIR, `${wantAi ? 'ai' : 'src'}-${stamp()}`);
      await fsp.mkdir(base, { recursive: true });
      const downloaded = await downloadAudio(picked.url, path.join(base, 'src'));
      const total = await probeDuration(downloaded);
      const start = Math.min(startSeconds ?? 0, Math.max(0, (total ?? 60) - length - 1));
      const outName = `sing-${slugify(picked.title || song)}${wantAi ? '-ai' : ''}-${stamp()}.mp3`;
      const outFile = uniqueVoicePath(outName);

      if (!wantAi) {
        await cutSegment(downloaded, outFile, start, length);
        await fsp.unlink(downloaded).catch(() => {});
        return json({
          name: path.basename(outFile),
          path: outFile,
          title: picked.title,
          source: picked.source,
          url: picked.url,
          requestedSeconds: length,
          startSeconds: start,
          sourceDurationSeconds: total,
          mode: 'original',
          bytes: fs.statSync(outFile).size,
          next: `用 qq_send_voice 传 voice="${path.basename(outFile)}" 发出去`,
        });
      }

      // ── AI 翻唱：截片段 → 分离人声/伴奏 → 换成她的音色 → 混回伴奏 ──
      const clipWav = path.join(base, 'clip.wav');
      await cutSegment(downloaded, clipWav, start, length);
      await fsp.unlink(downloaded).catch(() => {});
      const { vocals, instrumental } = await separateVocals(clipWav, base);
      const converted = path.join(base, 'vocals-ai.wav');
      await convertVoice(vocals, converted, pitch ?? 0);
      await mixTracks(converted, instrumental, outFile, length);

      return json({
        name: path.basename(outFile),
        path: outFile,
        title: picked.title,
        source: picked.source,
        url: picked.url,
        requestedSeconds: length,
        startSeconds: start,
        sourceDurationSeconds: total,
        mode: 'ai',
        pitch: pitch ?? 0,
        bytes: fs.statSync(outFile).size,
        next: `用 qq_send_voice 传 voice="${path.basename(outFile)}" 发出去`,
      });
    } catch (error) {
      return err(`唱歌失败：${error?.message ?? error}`);
    }
  },
);

server.tool(
  'sing_speak',
  '把一段文字用流萤的音色说出来并放进语音库（edge-tts 朗读 → RVC 换音色 → audio/ 目录）。与 sing_cover 的区别是不走搜歌/下载/截片段/人声分离，而是直接用文字生成，适合发短语音消息。生成后用 qq_send_voice 发出去。',
  {
    text: z.string().min(1).max(300).describe('要说的话（纯文本，建议 ≤ 30 字；太长 edge-tts 可能超时）'),
    voice: z.string().optional().describe('Edge-TTS 中文女声，默认 zh-CN-XiaoxiaoNeural；可选 zh-CN-XiaoyiNeural / zh-TW-HsiaoYuNeural 等'),
    pitch: z.number().int().min(-12).max(12).optional().describe('变调（半音），说话默认 0 不要动'),
    rate: z.string().optional().describe('语速调节，如 "+10%" 或 "-5%"；edge-tts 原生支持但 speak.py 暂未暴露，保留参数')
  },
  async ({ text, voice, pitch }) => {
    try {
      const checks = await readiness();
      const missing = [];
      if (!checks.venv.ok) missing.push('Python venv（sing/venv）');
      if (!checks.torch.ok) missing.push(`PyTorch（${checks.torch.detail ?? '未安装'}）`);
      if (!checks.rvc.ok) missing.push('RVC 推理代码（sing/rvc_cli）');
      if (!fs.existsSync(SPEAK_SCRIPT)) missing.push('TTS 脚本（sing/speak.py）');
      if (!checks.voiceModel.ok) missing.push('她的声音模型（sing/model/liuying.pth）');
      if (missing.length) {
        return err(`说话链路还没就绪，缺少：${missing.join('、')}`);
      }

      // 快速自检 edge-tts 是否装了
      try {
        await run(VENV_PY, ['-c', 'import edge_tts'], { timeout: 15000 });
      } catch {
        return err('缺少 edge-tts（需要 pip install edge-tts 到 sing/venv 里）');
      }

      const outFile = uniqueVoicePath(`speak-${stamp()}.wav`);
      const args = [SPEAK_SCRIPT, text, outFile];
      if (voice) args.push(voice);
      if (pitch != null) args.push(String(pitch));
      const log = await run(VENV_PY, args, { timeout: 120000 });

      if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1024) {
        return err(`说话生成失败：${String(log).slice(-300)}`);
      }

      return json({
        name: path.basename(outFile),
        path: outFile,
        bytes: fs.statSync(outFile).size,
        text,
        voice: voice ?? 'zh-CN-XiaoxiaoNeural',
        next: `用 qq_send_voice 传 voice="${path.basename(outFile)}" 发出去`,
      });
    } catch (error) {
      return err(`说话生成失败：${error?.message ?? error}`);
    }
  },
);

process.on('uncaughtException', (error) => {
  console.error('[mcp-sing] uncaught:', error?.message ?? error);
});
process.on('unhandledRejection', (error) => {
  console.error('[mcp-sing] unhandled:', error?.message ?? error);
});

await server.connect(new StdioServerTransport());
