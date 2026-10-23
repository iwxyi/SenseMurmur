import { useState } from 'react';
import { Card, CardContent, Chip, Stack, TextField, Typography, Tooltip, Box } from '@mui/material';
import type { AICharacter } from '../../types/character';
import type { ChatStyle, GroupChat, RuntimeEvolutionIntensity } from '../../types/chat';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { sanitizeUserFacingText } from '../../services/displayTextSanitizer';
import { buildSessionMemorySourcePresentation, type SessionMemoryConflictFilter } from '../../services/sessionMemorySourcePresentation';
import LayeredMemoryPanel from '../memory/LayeredMemoryPanel';
import DebugChip from '../common/DebugChip';
import { useDetailedFacts } from '../../hooks/useDetailedFacts';
import { DetailedFactsPanel } from '../character/DetailedFactsPanel';

interface RuntimeSeedSectionProps {
  editingChatId?: string;
  editingChatCreatedAt?: number;
  editingChatUpdatedAt?: number;
  editingChatLastMessageAt?: number;
  editingChatTimeline?: Array<{ type: 'note' | 'artifact' | 'relationship'; text: string; createdAt: number }>;
  editingChatRuntimeEvents?: GroupChat['runtimeEventsV2'];
  editingChatRelationshipLedger?: GroupChat['relationshipLedger'];
  editingChatLayeredMemories?: GroupChat['layeredMemories'];
  editingChatConflictAxes?: GroupChat['worldState']['conflictAxes'];
  editingChatConflictState?: GroupChat['worldState']['conflictState'];
  name: string;
  topic: string;
  style: ChatStyle;
  runtimeEvolutionIntensity: RuntimeEvolutionIntensity;
  selectedMembers: string[];
  showRoleActions: boolean;
  ownerCharacterId: string;
  adminCharacterIds: string[];
  autoModeration: boolean;
  allowMute: boolean;
  allowPrivateThreads: boolean;
  allowCliques: boolean;
  allowMockery: boolean;
  mood: string;
  focus: string;
  recentEvent: string;
  allowSpeakAs: boolean;
  allowDirectorMode: boolean;
  allowEventInjection: boolean;
  allowForcedReply: boolean;
  seedMemoryText: string;
  seedArtifactText: string;
  setSeedMemoryText: (value: string) => void;
  setSeedArtifactText: (value: string) => void;
  runtimePhaseLabel: string;
  runtimeMoodLabel: string;
  runtimeFocusLabel: string;
  runtimeRecentEventLabel: string;
  selectedCharacters: AICharacter[];
}

function cleanRuntimeText(text: string | undefined, characters: AICharacter[]) {
  return sanitizeUserFacingText(String(text || '').trim(), characters);
}

function tooltipText(text: string, title: string) {
  return (
    <Tooltip title={title} arrow placement="top-start">
      <Box component="span" sx={{ cursor: 'help', '&:hover': { textDecoration: 'underline dotted', textUnderlineOffset: '3px' } }}>{text}</Box>
    </Tooltip>
  );
}


export default function RuntimeSeedSection(props: RuntimeSeedSectionProps) {
  const factArchive = useDetailedFacts(undefined, props.editingChatId);
  const [conflictRelationFilter, setConflictRelationFilter] = useState<SessionMemoryConflictFilter>('all');
  const developerMode = useSettingsStore((state) => state.developerMode);
  const showRuntimeDebug = useSettingsStore((state) => state.developerUI.showMemoryDebug || state.developerUI.showAdvancedRuntimePanels);
  const includeDebug = developerMode && showRuntimeDebug;
  const presentation = buildSessionMemorySourcePresentation({
    chat: {
      runtimeEventsV2: props.editingChatRuntimeEvents,
      relationshipLedger: props.editingChatRelationshipLedger,
      layeredMemories: props.editingChatLayeredMemories,
      conflictAxes: props.editingChatConflictAxes,
      conflictState: props.editingChatConflictState,
    },
    members: props.selectedCharacters,
    name: props.name,
    topic: props.topic,
    style: props.style,
    runtimeEvolutionIntensity: props.runtimeEvolutionIntensity,
    memberCount: props.selectedMembers.length,
    seedArtifactText: props.seedArtifactText,
    runtimeLabels: {
      phase: props.runtimePhaseLabel,
      mood: props.runtimeMoodLabel,
      focus: props.runtimeFocusLabel,
      recentEvent: props.runtimeRecentEventLabel,
      createdAt: props.editingChatCreatedAt,
      updatedAt: props.editingChatUpdatedAt,
      lastMessageAt: props.editingChatLastMessageAt,
    },
    includeDebug,
  });
  const visibleConflictItems = presentation.conflict.items.filter((item) => conflictRelationFilter === 'all' || item.category === conflictRelationFilter);
  return (
    <Stack spacing={2}>
      <LayeredMemoryPanel
        title="记忆沉淀"
        memories={presentation.layeredMemoryItems}
        emptyText="暂无沉淀记忆"
        collapsedCount={4}
        expandedCount={16}
        includeRuntimeEvidence={includeDebug}
        showDebugChip={false}
        hideFilterHints
        formatMemoryText={(value) => cleanRuntimeText(value, props.selectedCharacters)}
        members={props.selectedCharacters}
        detailedFactsCount={factArchive.loading || factArchive.error ? undefined : factArchive.items.length}
        detailedFacts={props.editingChatId ? <DetailedFactsPanel key={props.editingChatId} archive={factArchive} /> : undefined}
      />

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>开场背景</Typography>
          </Box>
          <Stack spacing={2}>
            <Box>
              <Tooltip title="每行一条，适合写成大家已知的前情、共识、关系背景或房间默认设定。" placement="top-start">
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, width: 'fit-content', cursor: 'help' }}>前情设定</Typography>
              </Tooltip>
              <TextField
                value={props.seedMemoryText}
                onChange={(e) => props.setSeedMemoryText(e.target.value)}
                multiline
                rows={4}
                fullWidth
                placeholder={`例如：
大家默认知道记者小陈最近在追一条匿名爆料
心理医生和律师曾在上一轮争论过保密边界`}
              />
            </Box>
            <Box>
              <Tooltip title="只有准备预置清单、计划、纪要、结论、时间线等可引用内容时才需要；留空即可。" placement="top-start">
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, width: 'fit-content', cursor: 'help' }}>已有清单/结论</Typography>
              </Tooltip>
              <TextField
                value={props.seedArtifactText}
                onChange={(e) => props.setSeedArtifactText(e.target.value)}
                multiline
                rows={3}
                fullWidth
                placeholder={`例如：
待核实线索清单
已公开版本时间线`}
              />
              {presentation.artifacts.suspicious.length ? (
                <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.75 }}>
                  检测到 {presentation.artifacts.suspicious.length} 条可能不是清单或结论，保存时建议移到“前情设定”或直接删除。
                </Typography>
              ) : presentation.artifacts.valid.length ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>当前产物 {presentation.artifacts.valid.length} 条</Typography> : null}
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Typography variant="caption" color="text.secondary">下面只整理会话级记忆来源。当前轮运行、最近发言和调度原因请在聊天页运行态查看。</Typography>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>记忆来源</Typography>
            {includeDebug ? <Box sx={{ ml: 'auto' }}><DebugChip /></Box> : null}
          </Box>
          <Stack spacing={0.75}>
            <Typography variant="body2">{tooltipText(presentation.sourceSummary, presentation.sourceTooltip)}</Typography>
            <Typography variant="caption" color="text.secondary">用于决定前情、长期记忆、矛盾记忆和关系记忆如何沉淀，不展示当前聊天页的动态运行状态。</Typography>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>矛盾记忆</Typography>
            {includeDebug ? <Box sx={{ ml: 'auto' }}><DebugChip /></Box> : null}
          </Box>
          <Stack spacing={1}>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {presentation.conflict.chips.map((item) => (
                <Chip
                  key={item.value}
                  size="small"
                  label={`${item.label} ${item.count}`}
                  color={conflictRelationFilter === item.value ? 'primary' : 'default'}
                  variant={conflictRelationFilter === item.value ? 'filled' : 'outlined'}
                  onClick={() => setConflictRelationFilter(item.value)}
                />
              ))}
            </Stack>
            <Typography variant="body2">{tooltipText(presentation.conflict.summary, '从当前活跃矛盾、长期张力和历史冲突中整理出的会话记忆依据。')}</Typography>
            {visibleConflictItems.length ? visibleConflictItems.map((item) => (
              <Box key={item.id} sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                <Typography variant="body2">{item.tooltip ? tooltipText(item.summary, item.tooltip) : item.summary}</Typography>
                <Typography variant="caption" color="text.secondary">{item.tooltip ? tooltipText(item.meta, item.tooltip) : item.meta}</Typography>
              </Box>
            )) : <Typography variant="body2" color="text.secondary">暂无匹配的冲突记录</Typography>}
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>关系记忆</Typography>
            {includeDebug ? <Box sx={{ ml: 'auto' }}><DebugChip /></Box> : null}
          </Box>
          <Stack spacing={1}>
            <Typography variant="body2">{tooltipText(presentation.relationships.summary, '从关系账本中整理出的角色关系记忆。')}</Typography>
            {presentation.relationships.items.length ? presentation.relationships.items.map((line) => {
              const evidence = line.evidence;
              return (
                <Box key={line.key} sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                  <Typography variant="body2">{evidence ? tooltipText(line.body ? `${line.title}：${line.body}` : line.title, `最近证据：${evidence}`) : (line.body ? `${line.title}：${line.body}` : line.title)}</Typography>
                  {includeDebug && line.detail ? <Typography variant="caption" color="text.secondary">{line.detail}</Typography> : null}
                </Box>
              );
            }) : <Typography variant="body2" color="text.secondary">暂无关系记录</Typography>}
          </Stack>
        </CardContent>
      </Card>

    </Stack>
  );
}
