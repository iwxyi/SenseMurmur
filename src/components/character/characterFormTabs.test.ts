import { describe, expect, it } from 'vitest';
import { buildCharacterFormTabs } from './characterFormTabs';

describe('buildCharacterFormTabs', () => {
  it('hides runtime, activities, and diary tabs while creating a character', () => {
    const tabs = buildCharacterFormTabs({ isEditingExistingCharacter: false, isZh: true });

    expect(tabs.map((item) => item.label)).toEqual(['设定', '人格', '关系', '记忆']);
  });

  it('places activities inside the existing character editor before diary', () => {
    const tabs = buildCharacterFormTabs({ isEditingExistingCharacter: true, isZh: true });

    expect(tabs.map((item) => item.label)).toEqual(['设定', '人格', '关系', '记忆', '状态', '活动', '日记']);
    expect(tabs.find((item) => item.label === '活动')?.value).toBe(5);
    expect(tabs.find((item) => item.label === '日记')?.value).toBe(6);
  });

  it('keeps the same order in English', () => {
    const tabs = buildCharacterFormTabs({ isEditingExistingCharacter: true, isZh: false });

    expect(tabs.map((item) => item.label)).toEqual(['Config', 'Persona', 'Relations', 'Memory', 'Status', 'Activities', 'Diary']);
  });
});
