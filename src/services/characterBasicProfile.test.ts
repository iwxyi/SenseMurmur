import { describe, expect, it } from 'vitest';
import { getCharacterBasicProfileMissing } from './characterBasicProfile';

describe('character basic profile completion', () => {
  it('repairs duplicated identity hints even when both fields are nonempty', () => {
    expect(getCharacterBasicProfileMissing({ background: '电台主持人', speakingStyle: ' 电台主持人 ', expertise: ['主持'] }))
      .toEqual({ background: true, speakingStyle: true, expertise: false });
  });

  it('preserves distinct descriptions and identifies whitespace-only fields', () => {
    expect(getCharacterBasicProfileMissing({ background: '电台主持人', speakingStyle: '语调夸张，习惯用自嘲化解尴尬。', expertise: ['主持'] }))
      .toEqual({ background: false, speakingStyle: false, expertise: false });
    expect(getCharacterBasicProfileMissing({ background: ' ', speakingStyle: '\n', expertise: [] }))
      .toEqual({ background: true, speakingStyle: true, expertise: true });
  });

  it('recognizes legacy command placeholders', () => {
    expect(getCharacterBasicProfileMissing({ name: '角色甲', background: '角色甲 是根据用户指令创建的角色。', speakingStyle: '自然、清晰地表达观点。', expertise: [] }))
      .toEqual({ background: true, speakingStyle: true, expertise: true });
  });
});
