import { useEffect, useRef } from 'react';

// What just happened, for whatever moves or sounds with it: 'score' (a score landed, { id, score, verdict }),
// 'apply' ({ postingId }), 'fetch' (a search started) and 'batch-end' (a batch of scores finished).
const listeners = new Map();

export function emit(type, detail = {}) {
  (listeners.get(type) || []).forEach(listener => listener(detail));
}

export function useGroove(type, handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = detail => latest.current(detail);
    const set = listeners.get(type) || new Set();
    set.add(listener);
    listeners.set(type, set);
    return () => set.delete(listener);
  }, [type]);
}
