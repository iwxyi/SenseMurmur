import type { AICharacter } from '../types/character';

type BasicProfile = Pick<AICharacter, 'background' | 'speakingStyle' | 'expertise'> & { name?: string };

export function getCharacterBasicProfileMissing(character: BasicProfile) {
  const background = character.background.trim();
  const speakingStyle = character.speakingStyle.trim();
  // Older command-created drafts copied the same role hint into both fields.
  const duplicated = Boolean(background && background === speakingStyle);
  return {
    background: !background || duplicated || (Boolean(character.name) && background === `${character.name} 是根据用户指令创建的角色。`),
    speakingStyle: !speakingStyle || duplicated || speakingStyle === '自然、清晰地表达观点。',
    expertise: !character.expertise.length,
  };
}
