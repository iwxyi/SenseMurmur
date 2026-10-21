import type {
  MemoryItem,
  MemoryScope,
  MemorySubjectOwner,
  MemoryValidity,
  MemoryVisibility,
} from './memoryTypes';

/** Preserve known epistemic metadata when a memory becomes prompt prose. */
export function formatMemoryPerspectiveText(item: Pick<MemoryItem, 'text' | 'summary' | 'sourceTag' | 'kind' | 'validity'>) {
  const labels: string[] = [];
  if (item.sourceTag === 'llm_memory_character_perspective' || item.kind === 'bias') {
    labels.push('角色的主观理解，不代表他人真实动机');
  } else if (item.sourceTag === 'llm_memory_relationship_imprint') {
    labels.push('角色留下的关系印象，不代表对方的内心事实');
  }
  if (item.validity === 'uncertain') labels.push('尚未确认');
  const text = item.summary || item.text;
  return labels.length ? `【${labels.join('；')}】${text}` : text;
}

export interface MemoryDisclosureMetadata {
  subjectOwner: MemorySubjectOwner;
  privacyRisk: number;
  visibility: MemoryVisibility;
  validity: MemoryValidity;
}

function defaultVisibility(scope: MemoryScope): MemoryVisibility {
  if (scope === 'relationship' || scope === 'thread') return 'pair_private';
  if (scope === 'character_self') return 'private';
  return 'public_safe';
}

function defaultSubjectOwner(scope: MemoryScope): MemorySubjectOwner {
  if (scope === 'relationship' || scope === 'thread') return 'target';
  if (scope === 'character_self') return 'speaker';
  return 'unknown';
}

function visibilityRisk(visibility: MemoryVisibility) {
  if (visibility === 'never_surface') return 1;
  if (visibility === 'private') return 0.75;
  if (visibility === 'pair_private') return 0.55;
  return 0.05;
}

/**
 * Resolves legacy memories without interpreting their prose. New memories are
 * expected to carry model-produced disclosure metadata; scope-based defaults
 * exist only so older persisted data has deterministic, conservative behavior.
 */
export function resolveMemoryDisclosureMetadata(
  item: Pick<MemoryItem, 'scope' | 'subjectOwner' | 'privacyRisk' | 'visibility' | 'validity'>,
): MemoryDisclosureMetadata {
  const visibility = item.visibility || defaultVisibility(item.scope);
  const subjectOwner = item.subjectOwner || defaultSubjectOwner(item.scope);
  const declaredRisk = typeof item.privacyRisk === 'number' && Number.isFinite(item.privacyRisk)
    ? Math.max(0, Math.min(1, item.privacyRisk))
    : 0;
  const ownershipRisk = subjectOwner === 'third_party' ? 0.7 : 0;
  return {
    subjectOwner,
    visibility,
    privacyRisk: Math.max(declaredRisk, visibilityRisk(visibility), ownershipRisk),
    validity: item.validity || 'active',
  };
}
