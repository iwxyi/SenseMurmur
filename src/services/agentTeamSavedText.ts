import { teamTaskMediaKind, type AgentTeamTask } from './agentTeamPlan';
import { workflowJsonDigest } from './workflowToolRequest';
import { WorkflowPreflightError, type WorkflowSnapshot } from './workflowRunRuntime';
import type { AssistantArtifactItem } from '../types/assistantArtifact';

export interface AgentTeamSavedText {
  alias: string;
  taskId: string;
  attempt: number;
  outputSha256: string;
  artifact?: { id: string; versionId: string };
}

const TEXT_KINDS = new Set(['agent_text', 'agent_web_search', 'agent_image_inspection', 'agent_video_inspection', 'agent_delegation']);

function sourceArtifacts(snapshot: WorkflowSnapshot, taskId: string, artifacts: AssistantArtifactItem[]) {
  return artifacts.filter((item) => item.chatId === snapshot.run.chatId && item.deletedAt == null
    && item.sourceMessageId === `team-delivery-${snapshot.run.id}:${taskId}`);
}

export function sameTeamSavedTextVersion(left: Omit<AgentTeamSavedText, 'alias'>, right: Omit<AgentTeamSavedText, 'alias'>) {
  return left.taskId === right.taskId && left.attempt === right.attempt && left.outputSha256 === right.outputSha256
    && left.artifact?.id === right.artifact?.id && left.artifact?.versionId === right.artifact?.versionId;
}

function authorizedTextTasks(snapshot: WorkflowSnapshot, sourceTaskIds: string[]) {
  const allowed = new Set(sourceTaskIds);
  return snapshot.tasks.filter((task) => {
    if (!allowed.has(task.id) || task.runId !== snapshot.run.id || task.status !== 'completed' || task.attempt < 1
      || !TEXT_KINDS.has(task.kind) || typeof task.output !== 'string' || !task.output.trim()) return false;
    if (task.kind === 'agent_delegation') {
      const input = task.input;
      if (!input || typeof input !== 'object' || !('task' in input) || !input.task || typeof input.task !== 'object' || Array.isArray(input.task)
        || teamTaskMediaKind(input.task as AgentTeamTask)) return false;
    }
    return true;
  });
}

export function listTeamSavedText(snapshot: WorkflowSnapshot, sourceTaskIds: string[], artifacts: AssistantArtifactItem[] = []): Omit<AgentTeamSavedText, 'alias'>[] {
  return authorizedTextTasks(snapshot, sourceTaskIds).flatMap((task) => {
    const versions = sourceArtifacts(snapshot, task.id, artifacts).flatMap((artifact) => {
      const current = artifact.versions.find((version) => version.id === artifact.currentVersionId && version.artifactId === artifact.id);
      if (!current || current.files?.length || current.media?.length || !current.content.trim() || current.content.length > 12_000) return [];
      return [{ taskId: task.id, attempt: task.attempt, outputSha256: workflowJsonDigest(current.content),
        artifact: { id: artifact.id, versionId: current.id } }];
    });
    return [...versions, ...(String(task.output).length <= 12_000 ? [{ taskId: task.id, attempt: task.attempt, outputSha256: workflowJsonDigest(task.output) }] : [])];
  });
}

export function resolveTeamSavedText(task: AgentTeamTask, snapshot: WorkflowSnapshot, sourceTaskIds: string[], artifacts: AssistantArtifactItem[] = []) {
  if (!task.savedText?.length) return [];
  const available = listTeamSavedText(snapshot, sourceTaskIds);
  return task.savedText.map((reference) => {
    if (reference.artifact) {
      const source = authorizedTextTasks(snapshot, sourceTaskIds).find((item) => item.id === reference.taskId && item.attempt === reference.attempt);
      const artifact = sourceArtifacts(snapshot, reference.taskId, artifacts).find((item) => item.id === reference.artifact!.id);
      const version = artifact?.versions.find((item) => item.id === reference.artifact!.versionId && item.artifactId === artifact.id);
      if (!source || !version || version.files?.length || version.media?.length || !version.content.trim() || version.content.length > 12_000
        || workflowJsonDigest(version.content) !== reference.outputSha256) throw new WorkflowPreflightError('引用的文字产物不属于本次规划范围、指定版本不可用或正文已变化');
      return { alias: reference.alias, taskId: reference.taskId, content: version.content };
    }
    if (!available.some((source) => source.taskId === reference.taskId && source.attempt === reference.attempt
      && source.outputSha256 === reference.outputSha256)) throw new WorkflowPreflightError('历史文字交付不属于本次规划范围、正文过长或版本已变化');
    const source = snapshot.tasks.find((item) => item.id === reference.taskId)!;
    return { alias: reference.alias, taskId: reference.taskId, content: source.output as string };
  });
}
