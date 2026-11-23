import { useLayoutEffect, useRef } from 'react';
import { tell } from './tip.js';

// A sentence that explains a setting: not shown on the page, it is the tooltip of what it explains (tip.js). What
// a page must say (a warning, an error, a state, how to put something right) stays on the page and is not a Tip.
export function Tip({ children }) {
  const node = useRef(null);
  // After every render: the words change with the language and with what is chosen.
  useLayoutEffect(() => tell(node.current));
  return <span ref={node} className="tip" hidden>{children}</span>;
}
