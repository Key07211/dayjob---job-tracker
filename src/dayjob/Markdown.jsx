import { Fragment } from 'react';

// Descriptions arrive as light Markdown made by the server (headings, bullets,
// bold). Rendered as React text nodes only; no HTML from a job board is used.
function inline(text, keyPrefix) {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => (
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>
      : <Fragment key={`${keyPrefix}-${index}`}>{part.replace(/\\([*_#\-[\]()])/g, '$1')}</Fragment>
  ));
}

export function Markdown({ text }) {
  if (!text) return null;
  const blocks = [];
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: 'ul', items: list });
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); blocks.push({ type: 'h', text: heading[1].replace(/\*\*/g, '') }); }
    else if (bullet) { flushParagraph(); (list ||= []).push(bullet[1]); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph();
  flushList();
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.type === 'h') return <h4 key={index}>{inline(block.text, index)}</h4>;
        if (block.type === 'ul') return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `${index}-${itemIndex}`)}</li>)}</ul>;
        return <p key={index}>{inline(block.text, index)}</p>;
      })}
    </div>
  );
}
