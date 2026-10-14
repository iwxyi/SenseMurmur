import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { ChatStorageTarget } from '../types/localWorkspace';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  fetch: vi.fn(),
  exportFile: vi.fn(),
  save: vi.fn(),
  permission: vi.fn(),
  writeWorkspace: vi.fn(),
  workspaceState: { getDefaultStorageTarget: (): ChatStorageTarget => ({ kind: 'session' }), directories: [] as Array<{ id: string; name: string }> },
}));

vi.mock('./api', () => ({ api: { listNetworkDirectory: (...args: unknown[]) => mocks.list(...args) } }));
vi.mock('./networkResourceService', () => ({
  fetchNetworkResource: (...args: unknown[]) => mocks.fetch(...args),
  exportNetworkResource: (...args: unknown[]) => mocks.exportFile(...args),
}));
vi.mock('./sessionNetworkResourceStore', () => ({ saveSessionNetworkResource: (...args: unknown[]) => mocks.save(...args) }));
vi.mock('../stores/useLocalWorkspaceStore', () => ({
  useLocalWorkspaceStore: { getState: () => mocks.workspaceState },
}));
vi.mock('./localWorkspaceService', () => ({
  getLocalWorkspaceDirectoryPermission: (...args: unknown[]) => mocks.permission(...args),
  writeBinaryFileToLocalWorkspace: (...args: unknown[]) => mocks.writeWorkspace(...args),
}));

import { executeNetworkTransferTask } from './networkTransferService';

function binaryResult(url: string, bytes: Uint8Array) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    contentType: 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    fileName: url.split('/').at(-1) || 'download',
    encoding: 'base64' as const,
    content: btoa(binary),
    mode: 'download' as const,
    transport: 'server-fallback' as const,
  };
}

beforeEach(() => {
  [mocks.list, mocks.fetch, mocks.exportFile, mocks.save, mocks.permission, mocks.writeWorkspace].forEach((mock) => mock.mockReset());
  mocks.workspaceState = { getDefaultStorageTarget: () => ({ kind: 'session' as const }), directories: [] };
  mocks.writeWorkspace.mockResolvedValue({ path: '下载/file.bin', outcome: 'created' });
});

describe('executeNetworkTransferTask', () => {
  it('treats a recursive FTP directory as one task and exports one zip', async () => {
    mocks.list.mockResolvedValue({
      rootUrl: 'ftp://93.184.216.34/comp/',
      truncated: false,
      transferToken: 'task-token',
      files: [
        { url: 'ftp://93.184.216.34/comp/a.txt', path: 'a.txt', sizeBytes: 1 },
        { url: 'ftp://93.184.216.34/comp/sub/b.txt', path: 'sub/b.txt', sizeBytes: 1 },
      ],
    });
    mocks.fetch.mockImplementation((url: string) => Promise.resolve(binaryResult(url, strToU8(url.includes('a.txt') ? 'a' : 'b'))));

    const contexts = await executeNetworkTransferTask('chat-a', {
      url: 'ftp://93.184.216.34/comp/', mode: 'binary', action: 'export', recursive: true, destination: 'device',
    });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.exportFile).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('ftp://93.184.216.34/comp/a.txt', 'download', { transferToken: 'task-token' });
    expect(contexts[0]?.content).toContain('保存文件：2');
  });

  it('rejects zip entries that escape the destination', async () => {
    const archive = zipSync({ '../escape.txt': strToU8('no') });
    mocks.fetch.mockResolvedValue(binaryResult('https://example.com/archive.zip', archive));

    await expect(executeNetworkTransferTask('chat-a', {
      url: 'https://example.com/archive.zip', mode: 'binary', action: 'store', extractArchives: true, destination: 'session',
    })).rejects.toThrow('不安全的文件路径');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('falls back to session storage without prompting when the implicit default workspace is not authorized', async () => {
    mocks.workspaceState = {
      getDefaultStorageTarget: () => ({ kind: 'workspace' as const, workspaceId: 'workspace-a' }),
      directories: [{ id: 'workspace-a', name: '资料' }],
    };
    mocks.permission.mockResolvedValue('prompt');
    mocks.fetch.mockResolvedValue(binaryResult('https://example.com/file.bin', strToU8('data')));

    const contexts = await executeNetworkTransferTask('chat-a', {
      url: 'https://example.com/file.bin', mode: 'binary', action: 'store',
    });

    expect(mocks.permission).toHaveBeenCalledWith('workspace-a');
    expect(mocks.writeWorkspace).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(contexts[0]?.content).toContain('会话资源（默认工作区当前未授权）');
  });

  it('allows a permission request when the user explicitly selected a workspace', async () => {
    mocks.workspaceState = {
      getDefaultStorageTarget: () => ({ kind: 'session' as const }),
      directories: [{ id: 'workspace-a', name: '资料' }],
    };
    mocks.fetch.mockResolvedValue(binaryResult('https://example.com/file.bin', strToU8('data')));

    await executeNetworkTransferTask('chat-a', {
      url: 'https://example.com/file.bin', mode: 'binary', action: 'store', destination: 'workspace', workspaceId: 'workspace-a',
    });

    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.writeWorkspace).toHaveBeenCalledWith(expect.objectContaining({ requestPermission: true }));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('uses automatic rename by default and reports renamed files', async () => {
    mocks.workspaceState = {
      getDefaultStorageTarget: () => ({ kind: 'session' as const }),
      directories: [{ id: 'workspace-a', name: '资料' }],
    };
    mocks.writeWorkspace.mockResolvedValue({ path: '下载/file (1).bin', outcome: 'renamed' });
    mocks.fetch.mockResolvedValue(binaryResult('https://example.com/file.bin', strToU8('data')));

    const contexts = await executeNetworkTransferTask('chat-a', {
      url: 'https://example.com/file.bin', mode: 'binary', action: 'store', destination: 'workspace', workspaceId: 'workspace-a',
    });

    expect(mocks.writeWorkspace).toHaveBeenCalledWith(expect.objectContaining({ conflictPolicy: 'rename' }));
    expect(contexts[0]?.content).toContain('自动重命名：1');
  });
});
