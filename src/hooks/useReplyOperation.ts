import { useState, useSyncExternalStore } from 'react';
import { createReplyOperation } from '../services/replyOperation';

// The controller owns the busy state. Only its own completion may release it.
export function useReplyOperation() {
  const [operation] = useState(createReplyOperation);
  const pending = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  return { ...operation, pending };
}
