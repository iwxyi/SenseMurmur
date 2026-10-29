export type MasterDetailSection = 'chats' | 'characters';

export function getMasterDetailSection(pathname: string): MasterDetailSection | null {
  if (pathname === '/chats' || pathname === '/direct/create' || /^\/chats\/(create|[^/]+|[^/]+\/edit)$/.test(pathname)) return 'chats';
  if (pathname === '/characters' || /^\/characters\/(create|[^/]+\/edit)$/.test(pathname)) return 'characters';
  return null;
}
