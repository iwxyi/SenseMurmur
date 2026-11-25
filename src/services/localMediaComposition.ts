import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import classWorkerURL from '../workers/mediaComposition.worker?worker&url';
import type { MediaCompositionPlan } from './mediaCompositionPlan';
import { fetchMediaAssetContent } from './mediaAssetContent';

const MAX_INPUT_BYTES = 256 * 1024 * 1024;

export function canComposeMediaLocally() {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && Boolean(globalThis.navigator?.locks?.request);
}

export async function readCompositionMedia(url: string, signal: AbortSignal, maxBytes: number, kind: 'video' | 'audio'): Promise<Uint8Array> {
  const response = await fetchMediaAssetContent(url, kind, signal);
  if (!response.ok) throw new Error(`读取合成素材失败 (${response.status})`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('合成素材超过本机处理容量，请减少片段或降低清晰度');
  if (!response.body) throw new Error('合成素材没有可读取的内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('合成素材超过本机处理容量，请减少片段或降低清晰度');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('合成素材文件为空');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

interface Probe { duration: number; hasAudio: boolean; width?: number; height?: number }

export async function composeLocalMedia(params: {
  plan: MediaCompositionPlan;
  sources: Map<string, string>;
  signal: AbortSignal;
  onProgress?: (text: string) => void;
}): Promise<{ blob: Blob; width: number; height: number; durationMs: number }> {
  if (!canComposeMediaLocally()) throw new Error('此设备不支持本地音视频合成');
  return navigator.locks.request('pneumata-local-media-composition', { signal: params.signal }, async () => {
    const ffmpeg = new FFmpeg();
    const logs: string[] = [];
    ffmpeg.on('log', ({ message }) => { logs.push(message); if (logs.length > 12) logs.shift(); });
    const abort = () => ffmpeg.terminate();
    params.signal.addEventListener('abort', abort, { once: true });
    const exec = async (args: string[]) => {
      params.signal.throwIfAborted();
      if (await ffmpeg.exec(args, 300_000) !== 0) {
        console.error('[local-media-composition:ffmpeg]', { logs });
        throw new Error('本地合成失败：素材编码不受支持、处理超时或设备内存不足');
      }
    };
    try {
      params.signal.throwIfAborted();
      params.onProgress?.('正在加载本地合成引擎');
      await ffmpeg.load({ coreURL: new URL(coreURL, document.baseURI).href, wasmURL: new URL(wasmURL, document.baseURI).href,
        classWorkerURL: new URL(classWorkerURL, document.baseURI).href });
      const files = new Map<string, { file: string; probe: Probe }>();
      let totalBytes = 0;
      const sources = new Map<string, 'video' | 'audio'>();
      for (const clip of params.plan.clips) sources.set(clip.taskId, 'video');
      for (const track of params.plan.audioTracks ?? []) sources.set(track.taskId, 'audio');
      for (const [id, kind] of sources) {
        const url = params.sources.get(id);
        if (!url) throw new Error('合成素材文件尚未就绪');
        params.onProgress?.(`正在读取素材 ${files.size + 1}/${sources.size}`);
        const bytes = await readCompositionMedia(url, params.signal, MAX_INPUT_BYTES - totalBytes, kind);
        totalBytes += bytes.byteLength;
        const file = `input_${files.size}`;
        await ffmpeg.writeFile(file, bytes);
        const probeExit = await ffmpeg.ffprobe(['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file, '-o', 'probe.json'], 30_000);
        // core 0.12.10 leaves ret at -1 after a successful ffprobe; validate its fresh JSON output as well.
        if (probeExit !== 0 && probeExit !== -1) {
          console.error('[local-media-composition:probe]', probeExit, logs.join('\n'));
          throw new Error('无法识别合成素材的音视频格式');
        }
        const data = await ffmpeg.readFile('probe.json', 'utf8');
        await ffmpeg.deleteFile('probe.json');
        if (typeof data !== 'string') throw new Error('无法读取素材信息');
        const raw = JSON.parse(data) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
        const video = raw.streams?.find((stream) => stream.codec_type === 'video');
        const duration = Number(raw.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('素材时长无效，无法进行本地合成');
        files.set(id, { file, probe: { duration, hasAudio: Boolean(raw.streams?.some((stream) => stream.codec_type === 'audio')), width: video?.width, height: video?.height } });
      }
      const first = files.get(params.plan.clips[0].taskId)!.probe;
      const ratio = params.plan.aspectRatio || (first.width === first.height ? '1:1' : first.width && first.height && first.width < first.height ? '9:16' : '16:9');
      const [width, height] = ratio === '9:16' ? [720, 1280] : ratio === '1:1' ? [720, 720] : [1280, 720];
      let totalDuration = 0;
      let requestedDuration = 0;
      let totalFrames = 0;
      const clipDurations: number[] = [];
      for (const [index, clip] of params.plan.clips.entries()) {
        const source = files.get(clip.taskId)!;
        if (!source.probe.width || !source.probe.height) throw new Error('视频片段中没有画面轨道');
        const start = clip.startSeconds || 0;
        if (start >= source.probe.duration) throw new Error('片段裁剪起点超出了实际视频时长');
        requestedDuration += Math.min(clip.durationSeconds ?? source.probe.duration - start, source.probe.duration - start);
        // Quantize cumulative boundaries so per-clip rounding cannot accumulate across a long edit.
        const frames = Math.max(1, Math.round(requestedDuration * 24) - totalFrames);
        const duration = frames / 24;
        totalFrames += frames;
        totalDuration = totalFrames / 24;
        clipDurations.push(duration);
        if (requestedDuration > 600 || totalDuration > 600) throw new Error('当前设备单次本地合成最多支持 10 分钟，请拆分任务');
        params.onProgress?.(`正在处理片段 ${index + 1}/${params.plan.clips.length}`);
        await exec(['-ss', String(start), '-i', source.file, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
          '-map', '0:v:0', '-map', source.probe.hasAudio ? '0:a:0' : '1:a:0', '-t', String(duration),
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,setpts=PTS-STARTPTS`,
          '-af', 'aresample=48000,asetpts=PTS-STARTPTS', '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', `clip_${index}.mp4`]);
      }
      // AAC padding changes container duration; explicit visual durations preserve the edit boundaries.
      await ffmpeg.writeFile('clips.txt', new TextEncoder().encode(clipDurations.map((duration, index) => `file 'clip_${index}.mp4'\nduration ${duration}`).join('\n')));
      params.onProgress?.('正在合并视频片段');
      await exec(['-f', 'concat', '-safe', '0', '-i', 'clips.txt', '-c', 'copy', '-t', String(totalDuration), '-movflags', '+faststart', '-y', 'joined.mp4']);
      for (const index of params.plan.clips.keys()) await ffmpeg.deleteFile(`clip_${index}.mp4`);
      const tracks = params.plan.audioTracks || [];
      let output = 'joined.mp4';
      if (tracks.length || params.plan.originalAudioVolume !== undefined) {
        const args = ['-i', 'joined.mp4'];
        for (const track of tracks) {
          const source = files.get(track.taskId)!;
          if (!source.probe.hasAudio) throw new Error('配乐素材中没有音轨');
          if (track.loop) args.push('-stream_loop', '-1');
          args.push('-i', source.file);
        }
        const filters = [`[0:a]volume=${params.plan.originalAudioVolume ?? (tracks.length ? 0.3 : 1)}[base]`,
          ...tracks.map((track, index) => `[${index + 1}:a]aresample=48000,volume=${track.volume ?? 1},adelay=${Math.round((track.offsetSeconds || 0) * 1000)}:all=1[a${index}]`),
          `[base]${tracks.map((_, index) => `[a${index}]`).join('')}amix=inputs=${tracks.length + 1}:duration=first:normalize=0,alimiter=limit=0.95[mixed]`];
        params.onProgress?.('正在混合音轨');
        await exec([...args, '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mixed]', '-c:v', 'copy', '-c:a', 'aac', '-t', String(totalDuration), '-movflags', '+faststart', '-y', 'result.mp4']);
        output = 'result.mp4';
      }
      const bytes = await ffmpeg.readFile(output);
      if (typeof bytes === 'string') throw new Error('合成输出不是有效的视频文件');
      params.signal.throwIfAborted();
      return { blob: new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), width, height, durationMs: Math.round(totalDuration * 1000) };
    } finally {
      params.signal.removeEventListener('abort', abort);
      ffmpeg.terminate();
    }
  });
}
