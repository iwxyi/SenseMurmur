import { Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { useMemo, useState } from 'react';
import type { SessionActionDefinition } from '../../types/sessionEngine';
import SurfaceCard from '../common/SurfaceCard';
import SectionHeader from '../common/SectionHeader';
import PageSection from '../common/PageSection';

function getActionSurfaceSx() {
  return {
    p: { xs: 1, sm: 1.25 },
    borderRadius: 1,
    border: '1px solid',
    borderColor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(15,23,42,0.075)' : 'rgba(226,232,240,0.105)',
    bgcolor: (theme: Theme) => theme.palette.mode === 'light' ? 'rgba(255,255,255,0.50)' : 'rgba(255,255,255,0.050)',
    boxShadow: (theme: Theme) => theme.palette.mode === 'light'
      ? '0 1px 0 rgba(255,255,255,0.80) inset, 0 12px 28px rgba(15,23,42,0.045)'
      : '0 1px 0 rgba(255,255,255,0.08) inset, 0 14px 32px rgba(0,0,0,0.20)',
    backdropFilter: 'blur(18px) saturate(1.18)',
    WebkitBackdropFilter: 'blur(18px) saturate(1.18)',
  };
}

function getActionButtonLabel(action: SessionActionDefinition) {
  if (action.type === 'start_private_thread') return '创建角色私聊';
  if (action.type === 'apply_calendar_patch_drafts') return '应用草案';
  if (action.type === 'question_member') return '发起质询';
  if (action.type === 'submit_evidence') return '提交证据';
  if (action.type === 'record_verdict') return '记录裁决';
  if (action.type === 'summarize_discussion') return '生成总结';
  if (action.type === 'shift_to_synthesis') return '整理结论';
  return '执行动作';
}

function getFieldGridSx() {
  return {
    display: 'grid',
    gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
    gap: 1,
    mb: 1,
  };
}

function shouldSpanFullRow(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return field.type === 'textarea';
}

function buildFieldSx(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return shouldSpanFullRow(field) ? { gridColumn: '1 / -1' } : undefined;
}

function buildActionSubtitle(action: SessionActionDefinition) {
  return action.description || getActionHint(action);
}

function buildActionTitle(action: SessionActionDefinition) {
  return getActionLabel(action);
}

function buildActionSectionTitle(title: string) {
  return title;
}

function buildActionSectionSubtitle(actions: SessionActionDefinition[]) {
  return actions.length ? '在当前阶段执行派生、投票、干预或角色私聊动作。' : undefined;
}

function isActionDisabled(action: SessionActionDefinition, payloads: Record<string, Record<string, string>>) {
  return (action.fields || []).some((field) => field.required && !(payloads[action.type]?.[field.key] || '').trim());
}

function buildActionCardSpacing() {
  return 1;
}

function buildActionFormSpacing() {
  return 1;
}

function buildActionCardGap() {
  return 0.75;
}

function buildActionTitleWeight() {
  return 700;
}

function buildActionCaptionSx() {
  return { display: 'block', mt: 0.25, mb: 1 };
}

function buildActionButtonSx() {
  return { alignSelf: 'flex-start' as const };
}

function buildActionSurfaceVariant() {
  return 'contained' as const;
}

function buildActionButtonVariant(action: SessionActionDefinition) {
  if (action.type === 'start_private_thread' || action.type === 'apply_calendar_patch_drafts') return 'contained' as const;
  return 'outlined' as const;
}

function buildActionButtonColor(action: SessionActionDefinition) {
  if (action.type === 'apply_calendar_patch_drafts') return 'warning' as const;
  return action.type === 'start_private_thread' ? 'primary' as const : undefined;
}

function buildActionSurfacePadding() {
  return { xs: 1, sm: 1.25 };
}

function buildActionCardTone(index: number) {
  return index === 0 ? 'rgba(103, 80, 164, 0.06)' : 'action.hover';
}

function buildActionSectionSpacing() {
  return 1;
}

function buildActionEmptyText() {
  return '当前阶段暂无额外动作';
}

function buildFieldLabel(label: string) {
  return label;
}

function buildActionHelperText(text: string) {
  return text;
}

function buildActionTitleText(text: string) {
  return text;
}

function buildActionButtonText(action: SessionActionDefinition) {
  return getActionButtonLabel(action);
}

function buildActionSubtitleText(text: string) {
  return text;
}

function buildActionFieldPlaceholder(text: string | undefined) {
  return text;
}

function buildActionFieldRows(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return field.type === 'textarea' ? 3 : undefined;
}

function isActionPrimary(action: SessionActionDefinition) {
  return action.type === 'start_private_thread' || action.type === 'apply_calendar_patch_drafts';
}

function buildActionSectionContentSpacing() {
  return 1;
}

function buildActionTextFieldSize() {
  return 'small' as const;
}

function buildActionOutlinedVariant() {
  return 'outlined' as const;
}

function buildActionDenseHeader() {
  return false;
}

function buildActionFooterSpacing() {
  return 0.5;
}

function buildActionSurfaceStackGap() {
  return 1;
}

function buildActionCardKey(action: SessionActionDefinition, index: number) {
  return `${action.type}-${index}`;
}

function buildActionFieldKey(action: SessionActionDefinition, fieldKey: string) {
  return `${action.type}-${fieldKey}`;
}

function buildActionOptionKey(fieldKey: string, optionValue: string) {
  return `${fieldKey}-${optionValue}`;
}

function buildActionTextFieldType(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return field.type === 'number' ? 'number' : 'text';
}

function isActionMultiline(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return field.type === 'textarea';
}

function buildActionContentSx() {
  return { p: 2, '&:last-child': { pb: 2 } };
}

function buildActionSurfaceTitle(title: string) {
  return buildActionSectionTitle(title);
}

function buildActionSurfaceSubtitle(actions: SessionActionDefinition[]) {
  return buildActionSectionSubtitle(actions);
}

function buildActionSectionBodySpacing() {
  return 1;
}

function buildActionFieldLayout() {
  return getFieldGridSx();
}

function buildActionItemSx(index: number) {
  void index;
  return getActionSurfaceSx();
}

function buildActionItemPadding() {
  return buildActionSurfacePadding();
}

function buildActionPrimaryVariant(action: SessionActionDefinition) {
  return buildActionButtonVariant(action);
}

function buildActionPrimaryColor(action: SessionActionDefinition) {
  return buildActionButtonColor(action);
}

function buildActionButtonLabelText(action: SessionActionDefinition) {
  return buildActionButtonText(action);
}

function buildActionCardSubtitle(action: SessionActionDefinition) {
  return buildActionSubtitle(action);
}

function buildActionCardTitle(action: SessionActionDefinition) {
  return buildActionTitle(action);
}

function buildActionFieldRowsCount(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldRows(field);
}

function buildActionFieldSizeValue() {
  return buildActionTextFieldSize();
}

function buildActionFieldVariant() {
  return buildActionOutlinedVariant();
}

function buildActionSectionEmptyText() {
  return buildActionEmptyText();
}

function buildActionCardBackground(index: number) {
  return buildActionCardTone(index);
}

function buildActionCardPaddingValue() {
  return buildActionItemPadding();
}

function buildActionSectionHeaderDense() {
  return buildActionDenseHeader();
}

function buildActionSectionFooterSpacing() {
  return buildActionFooterSpacing();
}

function buildActionSectionStackGap() {
  return buildActionSurfaceStackGap();
}

function buildActionButtonStyle() {
  return buildActionButtonSx();
}

function buildActionCaptionStyle() {
  return buildActionCaptionSx();
}

function buildActionWeight() {
  return buildActionTitleWeight();
}

function buildActionSpacingValue() {
  return buildActionCardSpacing();
}

function buildActionFormSpacingValue() {
  return buildActionFormSpacing();
}

function buildActionGapValue() {
  return buildActionCardGap();
}

function buildActionSectionSpacingValue() {
  return buildActionSectionSpacing();
}

function buildActionBodySpacingValue() {
  return buildActionSectionBodySpacing();
}

function buildActionContentSpacingValue() {
  return buildActionSectionContentSpacing();
}

function buildActionSurfaceVariantValue() {
  return buildActionSurfaceVariant();
}

function buildActionSurfaceContentSx() {
  return buildActionContentSx();
}

function buildActionItemBackground(index: number) {
  return buildActionCardBackground(index);
}

function buildActionLayoutSx() {
  return buildActionFieldLayout();
}

function buildActionFieldItemSx(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildFieldSx(field);
}

function buildActionTextFieldMultiline(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return isActionMultiline(field);
}

function buildActionTextFieldRowsValue(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldRowsCount(field);
}

function buildActionTextFieldTypeValue(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionTextFieldType(field);
}

function buildActionPrimaryFlag(action: SessionActionDefinition) {
  return isActionPrimary(action);
}

function buildActionDisableFlag(action: SessionActionDefinition, payloads: Record<string, Record<string, string>>) {
  return isActionDisabled(action, payloads);
}

function buildActionHeaderTitle(title: string) {
  return buildActionSurfaceTitle(title);
}

function buildActionHeaderSubtitle(actions: SessionActionDefinition[]) {
  return buildActionSurfaceSubtitle(actions);
}

function buildActionHelperSubtitle(action: SessionActionDefinition) {
  return buildActionCardSubtitle(action);
}

function buildActionHelperTitle(action: SessionActionDefinition) {
  return buildActionCardTitle(action);
}

function buildActionPlaceholder(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldPlaceholder(field.placeholder);
}

function buildActionFieldLabelText(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildFieldLabel(field.label);
}

function buildActionOptionLabel(label: string) {
  return getOptionLabel(label);
}

function buildActionButtonVariantValue(action: SessionActionDefinition) {
  return buildActionPrimaryVariant(action);
}

function buildActionButtonColorValue(action: SessionActionDefinition) {
  return buildActionPrimaryColor(action);
}

function buildActionButtonTitle(action: SessionActionDefinition) {
  return buildActionButtonLabelText(action);
}

function buildActionEmptyMessage() {
  return buildActionSectionEmptyText();
}

function buildActionHeaderDenseFlag() {
  return buildActionSectionHeaderDense();
}

function buildActionSectionTitleText(title: string) {
  return buildActionHeaderTitle(title);
}

function buildActionSectionSubtitleText(actions: SessionActionDefinition[]) {
  return buildActionHeaderSubtitle(actions);
}

function buildActionCardTitleText(action: SessionActionDefinition) {
  return buildActionHelperTitle(action);
}

function buildActionCardSubtitleText(action: SessionActionDefinition) {
  return buildActionHelperSubtitle(action);
}

function buildActionExecuteLabel(action: SessionActionDefinition) {
  return buildActionButtonTitle(action);
}

function buildActionDisabledState(action: SessionActionDefinition, payloads: Record<string, Record<string, string>>) {
  return buildActionDisableFlag(action, payloads);
}

function buildActionFieldLabelValue(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldLabelText(field);
}

function buildActionFieldPlaceholderValue(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionPlaceholder(field);
}

function buildActionFieldMultilineFlag(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionTextFieldMultiline(field);
}

function buildActionFieldRowsNumber(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionTextFieldRowsValue(field);
}

function buildActionFieldTypeValueText(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionTextFieldTypeValue(field);
}

function buildActionOptionText(label: string) {
  return buildActionOptionLabel(label);
}

function buildActionPrimaryStyle(action: SessionActionDefinition) {
  return buildActionButtonVariantValue(action);
}

function buildActionPrimaryTone(action: SessionActionDefinition) {
  return buildActionButtonColorValue(action);
}

function buildActionHeaderSpacing() {
  return 1;
}

function buildActionStackSpacing() {
  return 1;
}

function buildActionInnerSpacing() {
  return 1;
}

function buildActionSurfaceHeaderSpacing() {
  return 1;
}

function buildActionCardHeaderSpacing() {
  return 0.75;
}

function buildActionCardFooterSpacing() {
  return 0.75;
}

function buildActionSectionSurfaceSpacing() {
  return 1;
}

function buildActionContentGap() {
  return 1;
}

function buildActionMetaGap() {
  return 0.75;
}

function buildActionGridGap() {
  return 1;
}

function buildActionCardRadius() {
  return 1;
}

function buildActionCardPaddingSx() {
  return { xs: 1, sm: 1.25 };
}

function buildActionCardSx(index: number) {
  void index;
  return {
    ...getActionSurfaceSx(),
    borderRadius: buildActionCardRadius(),
    p: buildActionCardPaddingSx(),
  };
}

function buildActionFieldWrapperSx(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldItemSx(field);
}

function buildActionFieldGrid() {
  return buildActionLayoutSx();
}

function buildActionPrimaryButtonSx() {
  return buildActionButtonStyle();
}

function buildActionCaptionBlockSx() {
  return buildActionCaptionStyle();
}

function buildActionSectionPageSpacing() {
  return buildActionSectionSpacingValue();
}

function buildActionSurfaceGap() {
  return buildActionContentGap();
}

function buildActionSurfaceContentSpacing() {
  return buildActionInnerSpacing();
}

function buildActionSurfaceHeaderGap() {
  return buildActionHeaderSpacing();
}

function buildActionCardHeaderGap() {
  return buildActionCardHeaderSpacing();
}

function buildActionCardFooterGap() {
  return buildActionCardFooterSpacing();
}

function buildActionMetaSpacing() {
  return buildActionMetaGap();
}

function buildActionGridSpacing() {
  return buildActionGridGap();
}

function buildActionWeightValue() {
  return buildActionWeight();
}

function buildActionSurfaceBodySx() {
  return buildActionSurfaceContentSx();
}

function buildActionSurfaceCardVariant() {
  return buildActionSurfaceVariantValue();
}

function buildActionPrimaryButtonVariant(action: SessionActionDefinition) {
  return buildActionPrimaryStyle(action);
}

function buildActionPrimaryButtonColor(action: SessionActionDefinition) {
  return buildActionPrimaryTone(action);
}

function buildActionFieldTextSize() {
  return buildActionFieldSizeValue();
}

function buildActionFieldTextVariant() {
  return buildActionFieldVariant();
}

function buildActionSectionText(title: string) {
  return buildActionSectionTitleText(title);
}

function buildActionSectionSubtext(actions: SessionActionDefinition[]) {
  return buildActionSectionSubtitleText(actions);
}

function buildActionTitleValue(action: SessionActionDefinition) {
  return buildActionCardTitleText(action);
}

function buildActionSubtitleValue(action: SessionActionDefinition) {
  return buildActionCardSubtitleText(action);
}

function buildActionExecuteText(action: SessionActionDefinition) {
  return buildActionExecuteLabel(action);
}

function buildActionDisabledValue(action: SessionActionDefinition, payloads: Record<string, Record<string, string>>) {
  return buildActionDisabledState(action, payloads);
}

function buildActionFieldLabelFinal(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldLabelValue(field);
}

function buildActionFieldPlaceholderFinal(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldPlaceholderValue(field);
}

function buildActionFieldTypeFinal(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldTypeValueText(field);
}

function buildActionFieldRowsFinal(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldRowsNumber(field);
}

function buildActionFieldMultilineFinal(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldMultilineFlag(field);
}

function buildActionOptionFinal(label: string) {
  return buildActionOptionText(label);
}

function buildActionCardContainerSx(index: number) {
  return buildActionCardSx(index);
}

function buildActionFieldsContainerSx() {
  return buildActionFieldGrid();
}

function buildActionCardHeaderTypographyWeight() {
  return buildActionWeightValue();
}

function buildActionHeaderProps(title: string, actions: SessionActionDefinition[]) {
  return {
    title: buildActionSectionText(title),
    subtitle: buildActionSectionSubtext(actions),
  };
}

function buildActionEmptyCopy() {
  return buildActionEmptyMessage();
}

function buildActionSurfaceSpacingValueFinal() {
  return buildActionSectionPageSpacing();
}

function buildActionCardSpacingValueFinal() {
  return buildActionSpacingValue();
}

function buildActionContentSpacingValueFinal() {
  return buildActionSurfaceContentSpacing();
}

function buildActionHeaderDenseValue() {
  return buildActionHeaderDenseFlag();
}

function buildActionPrimaryButtonProps(action: SessionActionDefinition) {
  return {
    variant: buildActionPrimaryButtonVariant(action),
    color: buildActionPrimaryButtonColor(action),
  };
}

function buildActionCardBodySx() {
  return buildActionSurfaceBodySx();
}

function buildActionPageSectionSpacing() {
  return buildActionSurfaceSpacingValueFinal();
}

function buildActionCardListSpacing() {
  return buildActionCardSpacingValueFinal();
}

function buildActionSurfaceStackSpacing() {
  return buildActionContentSpacingValueFinal();
}

function buildActionHeaderConfig(title: string, actions: SessionActionDefinition[]) {
  return buildActionHeaderProps(title, actions);
}

function buildActionButtonConfig(action: SessionActionDefinition) {
  return buildActionPrimaryButtonProps(action);
}

function buildActionEmptyStateCopy() {
  return buildActionEmptyCopy();
}

function buildActionHeaderDenseConfig() {
  return buildActionHeaderDenseValue();
}

function buildActionSurfaceBodyConfig() {
  return buildActionCardBodySx();
}

function buildActionListSpacingConfig() {
  return buildActionCardListSpacing();
}

function buildActionSurfaceSpacingConfig() {
  return buildActionPageSectionSpacing();
}

function buildActionStackSpacingConfig() {
  return buildActionSurfaceStackSpacing();
}

function buildActionCardConfig(index: number) {
  return buildActionCardContainerSx(index);
}

function buildActionFieldConfig(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldWrapperSx(field);
}

function buildActionFieldsConfig() {
  return buildActionFieldsContainerSx();
}

function buildActionTypographyWeight() {
  return buildActionCardHeaderTypographyWeight();
}

function buildActionHeaderInfo(title: string, actions: SessionActionDefinition[]) {
  return buildActionHeaderConfig(title, actions);
}

function buildActionButtonInfo(action: SessionActionDefinition) {
  return buildActionButtonConfig(action);
}

function buildActionEmptyInfo() {
  return buildActionEmptyStateCopy();
}

function buildActionSurfaceInfo() {
  return buildActionSurfaceBodyConfig();
}

function buildActionLayoutInfo() {
  return buildActionFieldsConfig();
}

function buildActionFieldInfo(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldConfig(field);
}

function buildActionCardInfo(index: number) {
  return buildActionCardConfig(index);
}

function buildActionSpacingInfo() {
  return buildActionStackSpacingConfig();
}

function buildActionHeaderMeta() {
  return buildActionHeaderDenseConfig();
}

function buildActionTitleWeightValue() {
  return buildActionTypographyWeight();
}

function buildActionHeaderState(title: string, actions: SessionActionDefinition[]) {
  return buildActionHeaderInfo(title, actions);
}

function buildActionButtonState(action: SessionActionDefinition) {
  return buildActionButtonInfo(action);
}

function buildActionEmptyState() {
  return buildActionEmptyInfo();
}

function buildActionSurfaceState() {
  return buildActionSurfaceInfo();
}

function buildActionLayoutState() {
  return buildActionLayoutInfo();
}

function buildActionFieldState(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldInfo(field);
}

function buildActionCardState(index: number) {
  return buildActionCardInfo(index);
}

function buildActionSpacingState() {
  return buildActionSpacingInfo();
}

function buildActionHeaderMode() {
  return buildActionHeaderMeta();
}

function buildActionWeightState() {
  return buildActionTitleWeightValue();
}

function buildActionSurfaceProps() {
  return buildActionSurfaceState();
}

function buildActionSurfaceListSpacing() {
  return buildActionSpacingState();
}

function buildActionCardProps(index: number) {
  return buildActionCardState(index);
}

function buildActionFieldProps(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldState(field);
}

function buildActionLayoutProps() {
  return buildActionLayoutState();
}

function buildActionHeaderPropsFinal(title: string, actions: SessionActionDefinition[]) {
  return buildActionHeaderState(title, actions);
}

function buildActionButtonPropsFinal(action: SessionActionDefinition) {
  return buildActionButtonState(action);
}

function buildActionEmptyProps() {
  return buildActionEmptyState();
}

function buildActionWeightProps() {
  return buildActionWeightState();
}

function buildActionHeaderDenseProps() {
  return buildActionHeaderMode();
}

function buildActionSectionSurfaceProps() {
  return buildActionSurfaceProps();
}

function buildActionSectionListSpacing() {
  return buildActionSurfaceListSpacing();
}

function buildActionSectionCardProps(index: number) {
  return buildActionCardProps(index);
}

function buildActionSectionFieldProps(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionFieldProps(field);
}

function buildActionSectionLayoutProps() {
  return buildActionLayoutProps();
}

function buildActionSectionHeaderProps(title: string, actions: SessionActionDefinition[]) {
  return buildActionHeaderPropsFinal(title, actions);
}

function buildActionSectionButtonProps(action: SessionActionDefinition) {
  return buildActionButtonPropsFinal(action);
}

function buildActionSectionEmptyProps() {
  return buildActionEmptyProps();
}

function buildActionSectionWeightProps() {
  return buildActionWeightProps();
}

function buildActionSectionDenseProps() {
  return buildActionHeaderDenseProps();
}

function buildActionPageSectionProps() {
  return buildActionSectionSurfaceProps();
}

function buildActionPageSpacingProps() {
  return buildActionSectionListSpacing();
}

function buildActionItemProps(index: number) {
  return buildActionSectionCardProps(index);
}

function buildActionInputProps(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionSectionFieldProps(field);
}

function buildActionGridProps() {
  return buildActionSectionLayoutProps();
}

function buildActionTopHeaderProps(title: string, actions: SessionActionDefinition[]) {
  return buildActionSectionHeaderProps(title, actions);
}

function buildActionExecuteProps(action: SessionActionDefinition) {
  return buildActionSectionButtonProps(action);
}

function buildActionFallbackProps() {
  return buildActionSectionEmptyProps();
}

function buildActionTextWeightProps() {
  return buildActionSectionWeightProps();
}

function buildActionDenseModeProps() {
  return buildActionSectionDenseProps();
}

function buildActionPageProps() {
  return buildActionPageSectionProps();
}

function buildActionSpacingProps() {
  return buildActionPageSpacingProps();
}

function buildActionBoxProps(index: number) {
  return buildActionItemProps(index);
}

function buildActionFormFieldProps(field: NonNullable<SessionActionDefinition['fields']>[number]) {
  return buildActionInputProps(field);
}

function buildActionFormGridProps() {
  return buildActionGridProps();
}

function buildActionHeaderSurface(title: string, actions: SessionActionDefinition[]) {
  return buildActionTopHeaderProps(title, actions);
}

function buildActionRunProps(action: SessionActionDefinition) {
  return buildActionExecuteProps(action);
}

function buildActionNoopProps() {
  return buildActionFallbackProps();
}

function buildActionWeightConfig() {
  return buildActionTextWeightProps();
}

function buildActionDenseConfig() {
  return buildActionDenseModeProps();
}

function buildActionPageConfig() {
  return buildActionPageProps();
}

function buildActionGapConfig() {
  return buildActionSpacingProps();
}

interface SessionActionPanelProps {
  title?: string;
  actions: SessionActionDefinition[];
  onRunAction: (action: SessionActionDefinition, payload: Record<string, unknown>) => void;
  hideHeader?: boolean;
  frameless?: boolean;
}

function getOptionLabel(label: string) {
  return label;
}

function getActionLabel(action: SessionActionDefinition) {
  if (action.type === 'apply_calendar_patch_drafts') return '应用日历草案';
  if (action.type === 'ask_question') return '提问动作';
  if (action.type === 'director_intervention') return '导演干预';
  if (action.type === 'start_private_thread') return '发起角色私聊';
  if (action.type === 'mute_member') return '禁言成员';
  if (action.type === 'unmute_member') return '解除禁言';
  if (action.type === 'question_member') return '质询成员';
  if (action.type === 'submit_evidence') return '提交证据';
  if (action.type === 'record_verdict') return '记录裁决';
  if (action.type === 'summarize_discussion') return '总结审议';
  if (action.type === 'shift_to_synthesis') return '结论整理';
  if (action.type === 'wolf_vote') return '夜晚袭击';
  if (action.type === 'inspect_player') return '夜晚查验';
  if (action.type === 'vote_player') return '白天投票';
  if (action.type === 'send_message') return '发言';
  return action.type;
}

function getActionHint(action: SessionActionDefinition) {
  if (action.type === 'apply_calendar_patch_drafts') return '把会话中的日历冲突修正草案一次性写入运行时事件。';
  if (action.type === 'ask_question') return '验证非聊天动作流：推进一个问题/环节，而不是直接发消息。';
  if (action.type === 'director_intervention') return '主持/导演对房间状态做一次明确干预。';
  if (action.type === 'start_private_thread') return '发起角色私聊或双方互动。';
  if (action.type === 'mute_member') return '暂时禁止指定成员被自动调度发言。';
  if (action.type === 'unmute_member') return '恢复指定成员的自动发言资格。';
  if (action.type === 'question_member') return '指定成员回应漏洞、证据或责任问题。';
  if (action.type === 'submit_evidence') return '把补充材料写入审议证据区。';
  if (action.type === 'record_verdict') return '记录当前阶段判断或裁决倾向。';
  if (action.type === 'summarize_discussion') return '整理当前审议的观点、证据、分歧和下一步。';
  if (action.type === 'shift_to_synthesis') return '切到结论整理阶段，之后仍可继续补充观点和总结。';
  if (action.type === 'wolf_vote') return '狼人夜晚协商并选择刀口。';
  if (action.type === 'inspect_player') return '预言家夜晚查验一名目标。';
  if (action.type === 'vote_player') return '白天公开投票并附带理由。';
  if (action.type === 'send_message') return '普通发言动作。';
  return '执行该 session action。';
}

export default function SessionActionPanel({ title = '动作面板', actions, onRunAction, hideHeader = false, frameless = false }: SessionActionPanelProps) {
  const initialState = useMemo(() => Object.fromEntries(actions.flatMap((action) => (action.fields || []).map((field) => [field.key, '']))), [actions]);
  const [payloads, setPayloads] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(actions.map((action) => [action.type, { ...initialState }])));

  const content = (
    <>
      {hideHeader ? null : <SectionHeader {...buildActionTopHeaderProps(title, actions)} dense={buildActionDenseConfig()} />}
      {actions.length ? (
        <PageSection spacing={buildActionGapConfig()} animate={false}>
          {actions.map((action, index) => (
            <Box key={buildActionCardKey(action, index)} sx={buildActionBoxProps(index)}>
              <Typography variant="body2" sx={{ fontWeight: buildActionWeightConfig() }}>{buildActionTitleValue(action)}</Typography>
              <Typography variant="caption" color="text.secondary" sx={buildActionCaptionBlockSx()}>{buildActionSubtitleValue(action)}</Typography>
              <Box sx={buildActionFormGridProps()}>
                {(action.fields || []).map((field) => field.type === 'single_select' ? (
                  <TextField
                    key={buildActionFieldKey(action, field.key)}
                    size={buildActionFieldTextSize()}
                    select
                    label={buildActionFieldLabelFinal(field)}
                    value={payloads[action.type]?.[field.key] || ''}
                    sx={buildActionFormFieldProps(field)}
                    onChange={(e) => setPayloads((current) => ({
                      ...current,
                      [action.type]: {
                        ...(current[action.type] || {}),
                        [field.key]: e.target.value,
                      },
                    }))}
                  >
                    {(field.options || []).map((option) => <MenuItem key={buildActionOptionKey(field.key, option.value)} value={option.value}>{buildActionOptionFinal(option.label)}</MenuItem>)}
                  </TextField>
                ) : (
                  <TextField
                    key={buildActionFieldKey(action, field.key)}
                    size={buildActionFieldTextSize()}
                    type={buildActionFieldTypeFinal(field)}
                    multiline={buildActionFieldMultilineFinal(field)}
                    minRows={buildActionFieldRowsFinal(field)}
                    label={buildActionFieldLabelFinal(field)}
                    placeholder={buildActionFieldPlaceholderFinal(field)}
                    value={payloads[action.type]?.[field.key] || ''}
                    sx={buildActionFormFieldProps(field)}
                    onChange={(e) => setPayloads((current) => ({
                      ...current,
                      [action.type]: {
                        ...(current[action.type] || {}),
                        [field.key]: e.target.value,
                      },
                    }))}
                  />
                ))}
              </Box>
              <Button
                size="small"
                variant={buildActionRunProps(action).variant}
                color={buildActionRunProps(action).color}
                sx={buildActionPrimaryButtonSx()}
                onClick={() => onRunAction(action, payloads[action.type] || {})}
                disabled={buildActionDisabledValue(action, payloads)}
              >
                {buildActionExecuteText(action)}
              </Button>
            </Box>
          ))}
        </PageSection>
      ) : <Typography variant="caption" color="text.secondary">{buildActionNoopProps()}</Typography>}
    </>
  );

  return frameless ? (
    <Box>{content}</Box>
  ) : (
    <SurfaceCard contentSx={buildActionPageProps()}>{content}</SurfaceCard>
  );
}
