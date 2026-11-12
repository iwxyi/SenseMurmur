import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { AgentTeamTask } from './agentTeamPlan';
import { WorkflowPreflightError } from './workflowRunRuntime';

export function teamOutputInstruction(task: AgentTeamTask): string {
  const spec = task.deliverable;
  if (!spec) return '';
  if (spec.kind === 'json') return '交付格式：只返回一个合法 JSON 值，不要附加说明或 Markdown 围栏。必须满足任务要求的字段；不要编造未知值。';
  return `交付格式：${spec.kind}${spec.language ? `（${spec.language}）` : ''}，标题：${spec.title}。只提交可供用户使用的产物正文。`;
}

export function validateTeamOutput(task: AgentTeamTask, raw: string): string {
  const output = raw.trim();
  if (!output) throw new WorkflowPreflightError('子 Agent 未提交内容');
  if (task.deliverable?.kind !== 'json') return output;
  let content = output;
  const tree = unified().use(remarkParse).parse(output);
  const block = tree.children.length === 1 ? tree.children[0] : undefined;
  if (block?.type === 'code' && (!block.lang || block.lang.toLowerCase() === 'json') && !block.meta) content = block.value.trim();
  try {
    JSON.parse(content);
  } catch {
    // Parser diagnostics can contain source text; keep the persisted error free of output content.
    throw new WorkflowPreflightError('交付格式校验失败：要求合法 JSON，返回内容无法解析。请重试该任务。');
  }
  return content;
}
