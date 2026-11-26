export function agentTeamMediaTitle(goal: string, fallback: string) {
  const firstLine = goal.trim().split(/[\n。；]/, 1)[0].replace(/\s+/g, ' ').trim();
  if (!firstLine) return fallback;
  const characters = Array.from(firstLine);
  return characters.length > 36 ? `${characters.slice(0, 36).join('')}…` : firstLine;
}
