// A small, safe renderer for the formatting the agents write: paragraphs, lists, headings,
// **bold**, `code`, fenced code blocks and links. It only ever creates text nodes and a fixed
// set of elements, so nothing an agent writes is treated as HTML.

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Inline formatting inside one line of text. */
function inline(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) fragment.append(text.slice(last, match.index));
    if (match[1]) fragment.append(element('code', '', match[1].slice(1, -1)));
    else if (match[2]) fragment.append(element('strong', '', match[2].slice(2, -2)));
    else {
      const address = (match[4] || match[5]).replace(/[.,;:!?]+$/, '');
      const link = element('a', '', match[3] || address);
      link.href = address;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      fragment.append(link, (match[4] || match[5]).slice(address.length));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

/** Renders an agent's message as a fragment of paragraphs, lists and code blocks. */
export function rich(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let paragraph = null;
  const close = () => {
    list = null;
    paragraph = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const code = [];
      for (index += 1; index < lines.length && !/^\s*```/.test(lines[index]); index += 1) code.push(lines[index]);
      close();
      fragment.append(element('pre', '', code.join('\n')));
      continue;
    }
    const item = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) close();
    else if (heading) {
      close();
      const node = element('p', 'heading');
      node.append(inline(heading[1]));
      fragment.append(node);
    } else if (item) {
      const kind = item[1] ? 'ul' : 'ol';
      if (!list || list.localName !== kind) {
        list = element(kind);
        if (item[2]) list.start = Number(item[2]);
        fragment.append(list);
      }
      paragraph = null;
      const node = element('li');
      node.append(inline(item[3]));
      list.append(node);
    } else if (list && /^\s{2,}\S/.test(line) && list.lastChild) {
      // an indented line continues the list item above it
      list.lastChild.append(' ', inline(line.trim()));
    } else {
      list = null;
      if (paragraph) paragraph.append(document.createElement('br'), inline(line));
      else {
        paragraph = element('p');
        paragraph.append(inline(line));
        fragment.append(paragraph);
      }
    }
  }
  return fragment;
}
