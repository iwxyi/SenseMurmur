import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { AgentTeamTask } from './agentTeamPlan';
import { WorkflowPreflightError } from './workflowRunRuntime';
import { parseAssistantTable } from './assistantArtifactTable';
import { matchesTeamJsonSchema } from './agentTeamJsonSchema';

export function teamOutputInstruction(task: AgentTeamTask): string {
  const spec = task.deliverable;
  if (!spec) return '';
  if (spec.kind === 'json') return '交付格式：只返回一个合法 JSON 值，不要附加说明或 Markdown 围栏。必须满足任务要求的字段；不要编造未知值。'
    + (spec.jsonSchema === undefined ? '' : `\nJSON 字段契约：${JSON.stringify(spec.jsonSchema)}`);
  if (spec.kind === 'table') return `交付格式：只返回一张 ${spec.language || 'CSV 或 Markdown'} 表格，包含非空且不重复的列名，每行列数一致。不要附加说明或 Markdown 围栏。`;
  return `交付格式：${spec.kind}${spec.language ? `（${spec.language}）` : ''}，标题：${spec.title}。只提交可供用户使用的产物正文。`;
}

export function validateTeamOutput(task: AgentTeamTask, raw: string): string {
  const output = raw.trim();
  if (!output) throw new WorkflowPreflightError('子 Agent 未提交内容');
  const kind = task.deliverable?.kind;
  if (kind !== 'json' && kind !== 'table') return output;
  let content = output;
  const tree = unified().use(remarkParse).parse(output);
  const block = tree.children.length === 1 ? tree.children[0] : undefined;
  const fenceLanguages = kind === 'json' ? ['json'] : ['csv', 'tsv', 'markdown', 'md'];
  if (block?.type === 'code' && (!block.lang || fenceLanguages.includes(block.lang.toLowerCase())) && !block.meta) content = block.value.trim();
  if (kind === 'table') {
    try {
      const parsed = parseAssistantTable(content, task.deliverable?.language);
      if (!parsed.columns.length) throw new Error('表格不能为空');
    } catch {
      throw new WorkflowPreflightError('交付格式校验失败：表格无法解析，列名须非空且唯一，各行列数须一致。请重试该任务。');
    }
    return content;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Parser diagnostics can contain source text; keep the persisted error free of output content.
    throw new WorkflowPreflightError('交付格式校验失败：要求合法 JSON，返回内容无法解析。请重试该任务。');
  }
  if (task.deliverable?.jsonSchema !== undefined && !matchesTeamJsonSchema(task.deliverable.jsonSchema, parsed)) {
    throw new WorkflowPreflightError('交付格式校验失败：JSON 不符合已声明的字段契约，请检查必填字段、类型与取值约束后重试该任务。');
  }
  return content;
}
