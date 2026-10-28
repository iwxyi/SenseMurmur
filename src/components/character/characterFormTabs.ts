export interface CharacterFormTabItem {
  value: number;
  label: string;
}

export function buildCharacterFormTabs(params: {
  isEditingExistingCharacter: boolean;
  isZh: boolean;
}): CharacterFormTabItem[] {
  const { isEditingExistingCharacter, isZh } = params;
  const baseTabs = [
    { value: 0, label: isZh ? '设定' : 'Config' },
    { value: 1, label: isZh ? '人格' : 'Persona' },
    { value: 2, label: isZh ? '关系' : 'Relations' },
    { value: 3, label: isZh ? '记忆' : 'Memory' },
  ];
  if (!isEditingExistingCharacter) return baseTabs;
  return [
    ...baseTabs,
    { value: 4, label: isZh ? '状态' : 'Status' },
    { value: 5, label: isZh ? '活动' : 'Activities' },
    { value: 6, label: isZh ? '日记' : 'Diary' },
  ];
}
