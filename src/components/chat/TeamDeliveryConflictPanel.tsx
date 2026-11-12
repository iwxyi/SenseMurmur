import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { WorkflowSnapshot } from '../../services/workflowRunRuntime';
import type { AssistantArtifactItem } from '../../types/assistantArtifact';
import { workflowArtifactIdentity } from '../../services/workflowDelivery';
import { useAssistantArtifactStore } from '../../stores/useAssistantArtifactStore';
import { useMessageStore } from '../../stores/useMessageStore';

function content(item: AssistantArtifactItem | null) {
  if (!item) return '产物不存在';
  if (item.deletedAt != null) return '产物已删除';
  const version = item.versions.find((entry) => entry.id === item.currentVersionId);
  if (!version) return '当前版本不存在';
  return version.content.length > 12000 ? `${version.content.slice(0, 12000)}\n（仅预览前 12000 字）` : version.content;
}

export default function TeamDeliveryConflictPanel({ snapshot, canSave, onSaveCopy }: {
  snapshot: WorkflowSnapshot;
  canSave: boolean;
  onSaveCopy: (snapshot: WorkflowSnapshot) => Promise<void>;
}) {
  const items = useAssistantArtifactStore((state) => state.items);
  const messages = useMessageStore((state) => state.messages);
  const windowMessages = useMessageStore((state) => state.messageWindowsByChatId[snapshot.run.chatId]?.messages);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const original = snapshot.run.delivery;
  const delivery = snapshot.run.deliveryCopy?.planVersion === snapshot.run.planVersion ? snapshot.run.deliveryCopy : original;
  if (!delivery || !['artifact_conflict', 'message_conflict'].includes(snapshot.run.deliveryIssue || '')) return null;
  const message = [...messages, ...(windowMessages || [])].find((entry) => entry.id === delivery.message.id || entry.clientKey === delivery.message.id);
  const previewStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 200, overflowY: 'auto', p: 1, bgcolor: 'action.hover', borderRadius: 1 } as const;
  return <Box sx={{ display: 'grid', gap: 1 }}>
    <Button size="small" onClick={() => setExpanded(!expanded)}>{expanded ? '收起交付对照' : '对照当前内容与候选交付'}</Button>
    {expanded && <>
      {delivery.artifacts.map(({ after }) => {
        const current = items.find((item) => item.id === after.id) ?? null;
        const unchanged = workflowArtifactIdentity(current) === workflowArtifactIdentity(after);
        return <Box key={after.id} sx={{ display: 'grid', gap: 0.75, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>{after.title}{unchanged ? ' · 已保存' : ''}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
            <Box sx={{ minWidth: 0 }}><Typography variant="caption">当前内容</Typography><Typography variant="body2" sx={previewStyle}>{content(current)}</Typography></Box>
            <Box sx={{ minWidth: 0 }}><Typography variant="caption">候选交付</Typography><Typography variant="body2" sx={previewStyle}>{content(after)}</Typography></Box>
          </Box>
        </Box>;
      })}
      {snapshot.run.deliveryIssue === 'message_conflict' && <Stack spacing={0.5}>
        <Typography variant="caption">当前消息</Typography><Typography variant="body2" sx={previewStyle}>{message?.isDeleted ? '消息已删除' : message?.content || '消息不存在'}</Typography>
        <Typography variant="caption">候选消息</Typography><Typography variant="body2" sx={previewStyle}>{delivery.message.content}</Typography>
      </Stack>}
      {error && <Typography role="alert" variant="body2" color="error.main">{error}</Typography>}
      {delivery.copyOfPlanVersion === undefined && <Button variant="outlined" size="small" disabled={!canSave || saving} onClick={() => {
        setSaving(true);
        setError(null);
        void onSaveCopy(snapshot).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '另存交付失败')).finally(() => setSaving(false));
      }}>{saving ? '正在另存…' : '保留现有内容，另存交付'}</Button>}
    </>}
  </Box>;
}
