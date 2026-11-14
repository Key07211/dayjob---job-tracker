import { useCallback, useSyncExternalStore } from 'react';

// Whether a media query holds just now, kept up to date as the window changes.
export function useMedia(query) {
  const watch = useCallback(notify => {
    const media = window.matchMedia(query);
    media.addEventListener('change', notify);
    return () => media.removeEventListener('change', notify);
  }, [query]);
  return useSyncExternalStore(watch, () => window.matchMedia(query).matches, () => false);
}
