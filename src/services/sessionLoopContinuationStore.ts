import type { SessionLoopContinuation } from './sessionRunner';
import { currentWorkflowScope } from './workflowRunRuntime';

const DB_NAME = 'pneumata-session-loop-continuations';
const STORE = 'continuations';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('此设备不支持会话续跑状态持久化'));
  if (dbPromise) return dbPromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开会话续跑状态失败'));
    request.onblocked = () => reject(new Error('会话续跑状态存储被其他页面阻塞'));
  });
  dbPromise = pending.catch((error: unknown) => { dbPromise = null; throw error; });
  return dbPromise;
}

function key(scope: string, chatId: string) { return `${scope}\n${chatId}`; }

export async function readSessionLoopContinuation(chatId: string, scope = currentWorkflowScope()) {
  const db = await openDb();
  return new Promise<SessionLoopContinuation | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key(scope, chatId));
    request.onsuccess = () => resolve((request.result as SessionLoopContinuation | undefined) || null);
    request.onerror = () => reject(request.error || new Error('读取会话续跑状态失败'));
    tx.onerror = () => reject(tx.error || new Error('读取会话续跑状态失败'));
  });
}

export async function writeSessionLoopContinuation(chatId: string, continuation: SessionLoopContinuation, scope = currentWorkflowScope()) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(continuation, key(scope, chatId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存会话续跑状态失败'));
    tx.onabort = () => reject(tx.error || new Error('保存会话续跑状态失败'));
  });
}
