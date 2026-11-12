import type { APIConfig } from '../types/settings';
import { generateResponse } from './aiClient';
import { sampleVideoInspectionFrames } from './videoInspectionFrames';
import { WorkflowPreflightError } from './workflowRunRuntime';

export async function inspectAgentTeamVideo(params: {
  api: APIConfig; chatId: string; goal: string; acceptance: string; url: string; maxFrames: number; signal: AbortSignal;
}) {
  let sampled: Awaited<ReturnType<typeof sampleVideoInspectionFrames>>;
  try { sampled = await sampleVideoInspectionFrames({ url: params.url, maxFrames: params.maxFrames, signal: params.signal }); }
  catch (error) { throw new WorkflowPreflightError(error instanceof Error ? error.message : '无法读取视频检查画面'); }
  params.signal.throwIfAborted();
  const scope = `抽帧检查：视频 ${sampled.width}×${sampled.height}，时长 ${sampled.durationSeconds.toFixed(2)} 秒；共 ${sampled.frames.length} 张，时间点依次为 ${sampled.frames.map((frame) => `${frame.timeSeconds.toFixed(2)} 秒`).join('、')}。仅抽样画面，未检查音轨或逐帧连续性。`;
  const result = await generateResponse(params.api,
    '你是视频抽帧检查员。附件是同一视频按时间顺序抽取的真实画面。只依据这些画面报告观察、与验收目标的差距及不确定性。不能把提示词当成画面事实，不能声称观看完整视频、听到声音、验证流畅度或验证未采样时刻。',
    [{ role: 'user', content: `${scope}\n检查目标：${params.goal}\n验收要求：${params.acceptance}`,
      attachments: sampled.frames.map((frame) => ({ url: frame.url, mimeType: 'image/jpeg' })) }], undefined,
    { responseFormat: 'text', maxTokens: 1800, signal: params.signal,
      aiUsage: { type: 'assistant_chat', label: '团队视频抽帧检查', scope: 'chat', resourceId: params.chatId } });
  if (!result.trim()) throw new Error('视频抽帧检查没有返回有效结果');
  return `${scope}\n${result.trim()}`;
}
