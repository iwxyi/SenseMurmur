export function buildMomentImagePrompt(actorName: string, postText: string) {
  const character = actorName.trim();
  const post = postText.trim();
  if (!character || !post) throw new Error('朋友圈配图需要角色名和已确定的动态正文');
  return `Create a candid image illustrating this published post by ${character}: ${post}. Depict only the people and events described in the post. No text or watermark.`;
}
