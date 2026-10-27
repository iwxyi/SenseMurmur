import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import HotIcon from '@mui/icons-material/LocalFireDepartment';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Avatar,
  Box,
  Chip,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { CHAT_STYLE_OPTIONS, MAX_MEMBERS } from '../../constants/defaults';
import type { ReactNode } from 'react';
import type { AICharacter } from '../../types/character';
import type { ChatStyle, RuntimeEvolutionIntensity } from '../../types/chat';
import { isImageAvatar } from '../../utils/avatar';
import SurfaceCard from '../common/SurfaceCard';

interface ChatConfigSectionProps {
  assistantOnly?: boolean;
  lockMembers?: boolean;
  showMembers?: boolean;
  maxMembers?: number;
  name: string;
  topic: string;
  showTopic?: boolean;
  style: ChatStyle;
  runtimeEvolutionIntensity: RuntimeEvolutionIntensity;
  showRoleActions: boolean;
  includeUserAsMember: boolean;
  operatorIdsText: string;
  ownerCharacterId?: string;
  adminCharacterIds?: string[];
  noOwnerLabel?: string;
  adminNotesValue?: string;
  autoModeration?: boolean;
  allowMute?: boolean;
  allowPrivateThreads?: boolean;
  conversationKind?: 'group' | 'direct' | 'ai_direct';
  conversationNoun?: string;
  editingChat?: boolean;
  selectedMembers: string[];
  selectedCharacters: AICharacter[];
  language: string;
  memberSummaryEmptyLabel: string;
  topicPlaceholder: string;
  getStyleLabel: (styleValue: ChatStyle) => string;
  onNameChange: (value: string) => void;
  onTopicChange: (value: string) => void;
  onStyleChange: (value: ChatStyle) => void;
  onRuntimeEvolutionIntensityChange: (value: RuntimeEvolutionIntensity) => void;
  onShowRoleActionsChange: (value: boolean) => void;
  onIncludeUserAsMemberChange: (value: boolean) => void;
  onOperatorIdsTextChange: (value: string) => void;
  onOwnerChange?: (value: string) => void;
  onAdminChange?: (value: string[]) => void;
  onAutoModerationChange?: (value: boolean) => void;
  onAllowMuteChange?: (value: boolean) => void;
  onAllowPrivateThreadsChange?: (value: boolean) => void;
  onOpenMemberDialog: () => void;
  onOpenBatchGenerate: () => void;
  onOpenHotDialog: () => void;
  onToggleMember: (memberId: string) => void;
  nameLabel: string;
  namePlaceholder: string;
  topicLabel: string;
  selectMembersLabel: string;
  membersHintLabel: string;
  styleLabel: string;
  showRoleActionsLabel: string;
  includeUserAsMemberLabel: string;
  includeUserAsMemberHint: string;
  operatorIdsLabel: string;
  operatorIdsHint: string;
  showOperatorSettings?: boolean;
  operatorValidationHint?: string;
  operatorNormalizedIds?: string[];
  openTopicInspirationLabel: string;
  batchGenerateMembersLabel: string;
  visualSettings?: ReactNode;
}

export default function ChatConfigSection(props: ChatConfigSectionProps) {
  const isZh = props.language.startsWith('zh');
  if (props.assistantOnly) return (
    <Stack spacing={2}>
      <SurfaceCard>
        <TextField
          label={isZh ? '会话名称' : 'Conversation name'}
          value={props.name}
          onChange={(event) => props.onNameChange(event.target.value)}
          fullWidth
        />
      </SurfaceCard>
      {props.visualSettings}
    </Stack>
  );
  const conversationKind = props.conversationKind || 'group';
  const isGroup = conversationKind === 'group';
  const ownerLabel = isGroup ? (isZh ? '群主' : 'Owner') : (isZh ? '主角色' : 'Primary role');
  const adminLabel = isGroup ? (isZh ? '管理员' : 'Admins') : (isZh ? '协同角色' : 'Supporting roles');
  const showManagementSettings = props.editingChat && props.onOwnerChange && props.onAdminChange && props.onAutoModerationChange && props.onAllowMuteChange;

  return (
    <Stack spacing={2}>
      <SurfaceCard>
          {props.showMembers === false ? null : (
            <TextField
              label={props.nameLabel}
              placeholder={props.namePlaceholder}
              value={props.name}
              onChange={(e) => props.onNameChange(e.target.value)}
              required
              fullWidth
              sx={{ mb: 2 }}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        color="primary"
                        onClick={props.onOpenHotDialog}
                        edge="end"
                        aria-label={props.openTopicInspirationLabel}
                      >
                        <HotIcon />
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
          )}
          {props.showTopic !== false ? (
            <TextField
              label={props.topicLabel}
              placeholder={props.topicPlaceholder}
              value={props.topic}
              onChange={(e) => props.onTopicChange(e.target.value)}
              fullWidth
              multiline
              rows={2}
            />
          ) : null}
      </SurfaceCard>

      <SurfaceCard>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 1.5 }}>
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {props.selectMembersLabel}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {props.membersHintLabel} ({props.selectedMembers.length}/{props.maxMembers || MAX_MEMBERS})
              </Typography>
            </Box>
            {props.lockMembers ? null : (
              <Box sx={{ display: 'flex', gap: 0.75, flexShrink: 0 }}>
                <IconButton color="primary" onClick={props.onOpenMemberDialog} aria-label={props.selectMembersLabel}>
                  <AddIcon />
                </IconButton>
                <IconButton color="primary" onClick={props.onOpenBatchGenerate} aria-label={props.batchGenerateMembersLabel}>
                  <AutoAwesomeIcon />
                </IconButton>
              </Box>
            )}
          </Box>
          {props.selectedCharacters.length > 0 ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {props.selectedCharacters.map((char) => (
                <Chip
                  key={char.id}
                  avatar={
                    <Avatar src={isImageAvatar(char.avatar) ? char.avatar : undefined} sx={{ bgcolor: 'primary.light' }}>
                      {isImageAvatar(char.avatar) ? undefined : char.avatar}
                    </Avatar>
                  }
                  label={char.name}
                  onDelete={props.lockMembers ? undefined : () => props.onToggleMember(char.id)}
                />
              ))}
            </Box>
          ) : (
            <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 3, color: 'text.secondary' }}>
              {props.memberSummaryEmptyLabel}
            </Box>
          )}
      </SurfaceCard>

      <SurfaceCard>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.75 }}>
            {isZh ? '表达与变化' : 'Expression and change'}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0, width: { xs: 108, sm: 124 }, textAlign: 'left' }}>{props.styleLabel}</Typography>
            <Box sx={{ display: 'flex', flex: 1, minWidth: 0, flexWrap: 'nowrap', gap: 0.75, overflowX: 'auto', pb: 0.25 }}>
              {CHAT_STYLE_OPTIONS.map((opt) => {
                const selected = props.style === opt.value;
                return (
                  <Chip
                    key={opt.value}
                    clickable
                    label={props.getStyleLabel(opt.value)}
                    color={selected ? 'primary' : 'default'}
                    variant={selected ? 'filled' : 'outlined'}
                    onClick={() => props.onStyleChange(opt.value)}
                    sx={{ height: 32, flexShrink: 0, borderRadius: 999, fontWeight: selected ? 700 : 500, '& .MuiChip-label': { px: 1.25 } }}
                  />
                );
              })}
            </Box>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0, width: { xs: 108, sm: 124 }, textAlign: 'left' }}>{isZh ? '变化沉淀速度' : 'Change settlement speed'}</Typography>
            <Box sx={{ display: 'flex', flex: 1, minWidth: 0, flexWrap: 'nowrap', gap: 0.75, overflowX: 'auto', pb: 0.25 }}>
              {([
                { value: 'slow' as const, zh: '慢', en: 'Slow' },
                { value: 'balanced' as const, zh: '平衡', en: 'Balanced' },
                { value: 'fast' as const, zh: '快', en: 'Fast' },
              ]).map((option) => (
                <Chip
                  key={option.value}
                  clickable
                  label={isZh ? option.zh : option.en}
                  color={props.runtimeEvolutionIntensity === option.value ? 'primary' : 'default'}
                  variant={props.runtimeEvolutionIntensity === option.value ? 'filled' : 'outlined'}
                  onClick={() => props.onRuntimeEvolutionIntensityChange(option.value)}
                  sx={{ height: 32, flexShrink: 0, borderRadius: 999, fontWeight: props.runtimeEvolutionIntensity === option.value ? 700 : 500, '& .MuiChip-label': { px: 1.25 } }}
                />
              ))}
            </Box>
          </Box>
      </SurfaceCard>

      {showManagementSettings ? (
        <SurfaceCard contentSx={{ p: 0, '&:last-child': { pb: 0 } }}>
          <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent', boxShadow: 'none', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: { xs: 2, sm: 2.25 }, py: 0.5 }}>
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  {isZh ? '管理设置' : 'Management'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {isZh ? '群主、管理员和权限开关' : 'Owner, admins, and permission toggles'}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ px: { xs: 2, sm: 2.25 }, pt: 0, pb: { xs: 2, sm: 2.25 } }}>
              <Box sx={{ display: 'grid', gap: 2 }}>
                <TextField
                  select
                  label={ownerLabel}
                  value={props.ownerCharacterId || ''}
                  onChange={(e) => props.onOwnerChange?.(e.target.value)}
                  fullWidth
                >
                  <MenuItem value="">{props.noOwnerLabel || ''}</MenuItem>
                  {props.selectedCharacters.map((char) => (
                    <MenuItem key={char.id} value={char.id}>{char.name}</MenuItem>
                  ))}
                </TextField>

                <TextField
                  select
                  slotProps={{ select: { multiple: true } }}
                  label={adminLabel}
                  value={props.adminCharacterIds || []}
                  onChange={(e) => props.onAdminChange?.((typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value).filter(Boolean))}
                  fullWidth
                >
                  {props.selectedCharacters.map((char) => (
                    <MenuItem key={char.id} value={char.id}>{char.name}</MenuItem>
                  ))}
                </TextField>

                <TextField
                  label={isZh ? `${adminLabel}说明` : `${adminLabel} notes`}
                  value={props.adminNotesValue || ''}
                  slotProps={{ input: { readOnly: true } }}
                  fullWidth
                />

                <Typography variant="caption" color="text.secondary">
                  {isGroup
                    ? (isZh ? '可多选管理员；群主不会重复加入管理员。' : 'You can select multiple admins; the owner is excluded automatically.')
                    : (isZh ? `${props.conversationNoun || '会话'}也使用同一套角色、关系、情绪和会话记忆；这些设置只影响权限和入口显示。` : `This ${props.conversationNoun || 'conversation'} uses the same role, relationship, emotion, and session-memory runtime. These settings only affect permissions and display.`)}
                </Typography>

                <Box sx={{ display: 'grid', gap: 0.5 }}>
                  <FormControlLabel control={<Switch checked={Boolean(props.autoModeration)} onChange={(e) => props.onAutoModerationChange?.(e.target.checked)} />} label={isZh ? '自动管理' : 'Auto moderation'} />
                  <FormControlLabel control={<Switch checked={Boolean(props.allowMute)} onChange={(e) => props.onAllowMuteChange?.(e.target.checked)} />} label={isZh ? '允许禁言' : 'Allow mute'} />
                  {isGroup ? <FormControlLabel control={<Switch checked={Boolean(props.allowPrivateThreads)} onChange={(e) => props.onAllowPrivateThreadsChange?.(e.target.checked)} />} label={isZh ? '允许角色私聊' : 'Allow character private chats'} /> : null}
                </Box>
              </Box>
            </AccordionDetails>
          </Accordion>
        </SurfaceCard>
      ) : null}

      {props.visualSettings}

      <SurfaceCard contentSx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
          <Stack spacing={0.5}>
            <FormControlLabel
              control={<Switch checked={props.showRoleActions} onChange={(e) => props.onShowRoleActionsChange(e.target.checked)} />}
              label={props.showRoleActionsLabel}
            />
            {props.showMembers === false ? null : (
              <FormControlLabel
                sx={{ m: 0 }}
                control={<Switch checked={props.includeUserAsMember} onChange={(e) => props.onIncludeUserAsMemberChange(e.target.checked)} />}
                label={
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    <span>{props.includeUserAsMemberLabel}</span>
                    <Tooltip title={props.includeUserAsMemberHint}>
                      <HelpOutlineIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                    </Tooltip>
                  </Box>
                }
              />
            )}
            {props.showOperatorSettings ? <Box sx={{ pt: 0.5 }}>
              <TextField
                label={props.operatorIdsLabel}
                placeholder="host, narrator_bot"
                value={props.operatorIdsText}
                onChange={(e) => props.onOperatorIdsTextChange(e.target.value)}
                fullWidth
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <Tooltip title={props.operatorIdsHint}>
                          <IconButton size="small" aria-label={isZh ? '内部操作角色说明' : 'About internal operators'}>
                            <HelpOutlineIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  },
                }}
              />
              {props.operatorValidationHint ? (
                <Typography variant="caption" color="warning.main" sx={{ mt: 0.35, display: 'block' }}>
                  {props.operatorValidationHint}
                </Typography>
              ) : null}
              {props.operatorNormalizedIds?.length ? (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.35, display: 'block' }}>
                  {`IDs: ${props.operatorNormalizedIds.join(', ')}`}
                </Typography>
              ) : null}
            </Box> : null}
          </Stack>
      </SurfaceCard>
    </Stack>
  );
}
