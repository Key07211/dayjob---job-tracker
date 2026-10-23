// Runs inside web pages opened in the Dayjob browser, in an isolated world that
// the page's own scripts cannot reach. Each link, button and field gets a ref
// (e1, e2, …) that stays the same for the life of the document, so Claude can
// read a page once and then act on what it read.
function install() {
  if (globalThis.dayjobPage) return globalThis.dayjobPage;
  const refs = new Map();
  const ids = new WeakMap();
  let next = 0;
  const FIELDS = 'a[href], button, input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="searchbox"]';
  // Labels of actions that send, submit or delete something for the user.
  const RISKY = /\b(submit|send|confirm|finish|complete|pay|purchase|buy|place order|delete|remove|withdraw|unsubscribe)\b|提交|投递|发送|确认|完成|支付|付款|购买|删除|撤回/i;
  const BUTTON_TYPES = ['submit', 'button', 'reset', 'image'];
  const clean = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const textOf = node => clean(node?.innerText || node?.textContent || '', 200);

  // The document, its same-origin frames and open shadow roots; other sites'
  // frames cannot be read from here, so their links are listed instead.
  function roots() {
    const found = [];
    const frames = [];
    const visit = root => {
      found.push(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot);
        if (element.tagName !== 'IFRAME' && element.tagName !== 'FRAME') continue;
        let inner = null;
        try { inner = element.contentDocument; } catch { /* another site */ }
        if (inner?.documentElement) visit(inner);
        else {
          const rect = element.getBoundingClientRect();
          if (/^https?:/i.test(element.src) && rect.width * rect.height >= 2500) frames.push(element.src.slice(0, 500));
        }
      }
    };
    visit(document);
    return { found, frames };
  }

  function role(element) {
    const given = element.getAttribute('role');
    if (given) return given;
    const tag = element.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') {
      if (element.type === 'checkbox' || element.type === 'radio') return element.type;
      if (BUTTON_TYPES.includes(element.type)) return 'button';
      if (element.type === 'file') return 'file';
      if (element.type === 'range' || element.type === 'color') return element.type;
      return 'textbox';
    }
    return element.isContentEditable ? 'textbox' : tag.toLowerCase();
  }

  function name(element) {
    const aria = element.getAttribute('aria-label');
    if (aria?.trim()) return clean(aria);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = element.getRootNode();
      const joined = labelledBy.split(/\s+/).map(id => textOf(root.getElementById?.(id) || element.ownerDocument.getElementById(id))).filter(Boolean).join(' ');
      if (joined) return clean(joined);
    }
    if (element.labels?.length) {
      const joined = [...element.labels].map(textOf).filter(Boolean).join(' ');
      if (joined) return clean(joined);
    }
    if (element.tagName === 'INPUT' && BUTTON_TYPES.includes(element.type)) return clean(element.value || element.alt || element.type);
    const own = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : textOf(element);
    if (own) return clean(own);
    return clean(element.getAttribute('placeholder') || element.getAttribute('title') || element.querySelector?.('img[alt]')?.alt || element.getAttribute('name') || '');
  }

  // Custom checkboxes hide the real input and draw its label instead.
  function clickable(element) {
    const rect = element.getBoundingClientRect();
    const hidden = rect.width < 2 || rect.height < 2 || element.ownerDocument.defaultView.getComputedStyle(element).opacity === '0';
    if (!hidden || !element.labels?.length) return element;
    return [...element.labels].find(label => label.checkVisibility()) || element;
  }

  function shown(element) {
    if (element.type === 'hidden' || element.closest('[aria-hidden="true"], [inert]')) return false;
    const target = clickable(element);
    if (!target.checkVisibility({ visibilityProperty: true })) return false;
    const rect = target.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  function frameOffset(element) {
    let x = 0;
    let y = 0;
    let view = element.ownerDocument.defaultView;
    while (view && view !== window) {
      const frame = view.frameElement;
      if (!frame) break;
      const rect = frame.getBoundingClientRect();
      x += rect.left + frame.clientLeft;
      y += rect.top + frame.clientTop;
      view = frame.ownerDocument.defaultView;
    }
    return { x, y };
  }

  function inViewport(element) {
    const rect = element.getBoundingClientRect();
    const offset = frameOffset(element);
    return rect.bottom + offset.y > 0 && rect.top + offset.y < window.innerHeight && rect.right + offset.x > 0 && rect.left + offset.x < window.innerWidth;
  }

  const disabled = element => Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true');
  const editable = element => element.isContentEditable || element.tagName === 'TEXTAREA'
    || (element.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'range', 'color', ...BUTTON_TYPES].includes(element.type));
  const secret = element => element.type === 'password' || /^cc-|one-time-code/.test(element.autocomplete || '');

  function value(element) {
    if (element.tagName === 'SELECT') return clean(element.selectedOptions[0]?.text || '', 200);
    if (element.isContentEditable) return textOf(element);
    if (!editable(element) || typeof element.value !== 'string' || !element.value) return undefined;
    return secret(element) ? '(filled)' : clean(element.value, 300);
  }

  function describe(element, ref) {
    const item = { ref, role: role(element), name: name(element) };
    if (element.tagName === 'A' && element.href) item.href = element.href.slice(0, 300);
    if (element.tagName === 'INPUT' && item.role === 'textbox' && element.type !== 'text') item.type = element.type;
    if (element.tagName === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio')) item.checked = element.checked;
    else if (element.hasAttribute('aria-checked')) item.checked = element.getAttribute('aria-checked') === 'true';
    const current = value(element);
    if (current) item.value = current;
    if (element.tagName === 'SELECT') item.options = [...element.options].slice(0, 40).map(option => clean(option.text, 80));
    if (element.hasAttribute('aria-expanded')) item.expanded = element.getAttribute('aria-expanded') === 'true';
    if (disabled(element)) item.disabled = true;
    if (element.required || element.getAttribute('aria-required') === 'true') item.required = true;
    if (!inViewport(element)) item.offscreen = true;
    return item;
  }

  function refFor(element) {
    let ref = ids.get(element);
    if (!ref) {
      next += 1;
      ref = `e${next}`;
      ids.set(element, ref);
      refs.set(ref, new WeakRef(element));
    }
    return ref;
  }
  function find(ref) {
    const element = refs.get(ref)?.deref();
    return element?.isConnected ? element : null;
  }

  function heavyForm(form) {
    if (!form) return false;
    const fields = [...form.elements].filter(field => ['INPUT', 'SELECT', 'TEXTAREA'].includes(field.tagName) && field.type !== 'hidden' && !BUTTON_TYPES.includes(field.type));
    return fields.length >= 3 || fields.some(field => field.type === 'file' || field.type === 'password');
  }
  // Submitting an application, sending a message or deleting something waits
  // for the user; search boxes and "Next" buttons do not.
  function risky(element) {
    if (RISKY.test(name(element))) return true;
    const submits = (element.tagName === 'BUTTON' && element.type === 'submit') || (element.tagName === 'INPUT' && (element.type === 'submit' || element.type === 'image'));
    return submits && heavyForm(element.form);
  }

  function focused() {
    let element = document.activeElement;
    for (;;) {
      let inner = element?.shadowRoot?.activeElement || null;
      if (!inner && (element?.tagName === 'IFRAME' || element?.tagName === 'FRAME')) {
        try { inner = element.contentDocument?.activeElement || null; } catch { /* another site */ }
      }
      if (!inner) break;
      element = inner;
    }
    return element && element !== element.ownerDocument.body ? element : null;
  }

  function htmlText(html) {
    let source = String(html || '');
    if (!/<[a-z]/i.test(source) && /&lt;/i.test(source)) source = new DOMParser().parseFromString(source, 'text/html').documentElement.textContent;
    source = source.replace(/<\s*li\b[^>]*>/gi, '\n• ').replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div|\/ul|\/ol|\/tr)\b[^>]*>/gi, '\n');
    const text = new DOMParser().parseFromString(source, 'text/html').documentElement.textContent || '';
    return text.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+• /g, '\n• ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // schema.org JobPosting, which most job boards and career sites publish.
  function jobPosting() {
    const found = [];
    const visit = item => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item)) { item.forEach(visit); return; }
      const type = item['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) found.push(item);
      if (item['@graph']) visit(item['@graph']);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); } catch { /* not JSON */ }
    }
    const job = found[0];
    if (!job) return null;
    const string = item => (typeof item === 'string' ? item : item?.name && typeof item.name === 'string' ? item.name : '');
    const organization = [].concat(job.hiringOrganization || [])[0];
    const places = [].concat(job.jobLocation || []).map(place => {
      const address = place?.address;
      if (typeof address === 'string') return address;
      return [address?.addressLocality, address?.addressRegion, string(address?.addressCountry)].filter(part => typeof part === 'string' && part).join(', ');
    }).filter(Boolean);
    const pay = job.baseSalary?.value;
    const salary = pay && typeof pay === 'object'
      ? { min: Number(pay.minValue ?? pay.value) || null, max: Number(pay.maxValue ?? pay.value) || null, interval: string(pay.unitText).toLowerCase() || null, currency: string(job.baseSalary.currency) || null }
      : null;
    return {
      title: clean(job.title, 240), company: clean(string(organization), 160), location: clean(places.join('; '), 160),
      remote: job.jobLocationType === 'TELECOMMUTE', datePosted: string(job.datePosted) || null, validThrough: string(job.validThrough) || null,
      employmentType: [].concat(job.employmentType || []).filter(item => typeof item === 'string'), salary,
      description: htmlText(job.description).slice(0, 100000), url: typeof job.url === 'string' ? job.url : null,
    };
  }

  function pageText(found) {
    return found.map(root => (root.body || root).innerText || '').join('\n\n')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return (globalThis.dayjobPage = {
    snapshot({ query = '', maxChars = 15000, maxElements = 250 } = {}) {
      const { found, frames } = roots();
      const wanted = clean(query, 200).toLowerCase();
      const elements = [];
      let count = 0;
      for (const root of found) {
        for (const element of root.querySelectorAll(FIELDS)) {
          if (!shown(element)) continue;
          const item = describe(element, refFor(element));
          if (wanted && ![item.name, item.href, item.value].some(text => text?.toLowerCase().includes(wanted))) continue;
          count += 1;
          if (elements.length < maxElements) elements.push(item);
        }
      }
      const text = pageText(found);
      return { title: document.title, text: text.slice(0, maxChars), textTruncated: text.length > maxChars, elements, elementCount: count, otherSiteFrames: frames, jobPosting: jobPosting() };
    },

    // Where to click, after scrolling the element into view.
    target({ ref }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      const info = { role: role(element), name: name(element), disabled: disabled(element), risky: risky(element), editable: editable(element) };
      const point = clickable(element);
      point.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = point.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 40);
      const y = rect.top + rect.height / 2;
      const hit = point.getRootNode().elementFromPoint?.(x, y) || point.ownerDocument.elementFromPoint(x, y);
      const reaches = hit && (hit === point || point.contains(hit) || hit.contains(point) || [...(element.labels || [])].some(label => label.contains(hit)));
      if (!reaches) info.coveredBy = hit ? `${hit.tagName.toLowerCase()} “${textOf(hit).slice(0, 80) || hit.className}”` : 'nothing (outside the window)';
      const offset = frameOffset(point);
      return { ...info, x: x + offset.x, y: y + offset.y };
    },

    focus({ ref, append = false }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      if (!editable(element)) return { error: 'not-editable', role: role(element) };
      if (secret(element)) return { error: 'secret' };
      if (disabled(element) || element.readOnly) return { error: 'disabled' };
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      element.focus();
      const doc = element.ownerDocument;
      if (element.isContentEditable) {
        const range = doc.createRange();
        range.selectNodeContents(element);
        if (append) range.collapse(false);
        doc.getSelection().removeAllRanges();
        doc.getSelection().addRange(range);
      } else if (append) {
        try { element.setSelectionRange(element.value.length, element.value.length); } catch { /* email and number fields */ }
      } else element.select();
      return { name: name(element), focused: focused() === element };
    },

    read({ ref }) {
      const element = find(ref);
      return element ? { value: value(element) ?? '' } : { error: 'missing' };
    },

    // For fields that did not take typed text: set the value the way a user's
    // edit would, so page frameworks notice it.
    fill({ ref, text, append = false }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      const next = append ? `${element.isContentEditable ? element.innerText : element.value}${text}` : text;
      if (element.isContentEditable) element.textContent = next;
      else element.value = next;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: value(element) ?? '' };
    },

    choose({ ref, option }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      if (element.tagName !== 'SELECT') return { error: 'not-select', role: role(element) };
      if (disabled(element)) return { error: 'disabled' };
      const wanted = clean(option, 200).toLowerCase();
      const options = [...element.options];
      const match = options.find(item => clean(item.text).toLowerCase() === wanted || item.value.toLowerCase() === wanted)
        || options.find(item => clean(item.text).toLowerCase().includes(wanted));
      if (!match) return { error: 'no-option', options: options.slice(0, 40).map(item => clean(item.text, 80)) };
      element.focus();
      element.value = match.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { name: name(element), value: clean(match.text) };
    },

    reveal({ ref }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      clickable(element).scrollIntoView({ block: 'center', behavior: 'instant' });
      return { name: name(element) };
    },

    // Whether a key press on the focused element could submit something.
    keyRisk({ key }) {
      const element = focused();
      if (!element) return { risky: false, name: '' };
      const buttonLike = ['button', 'link', 'menuitem'].includes(role(element));
      const field = element.tagName === 'INPUT' && editable(element);
      const risk = (key === 'Enter' || key === 'Space') && buttonLike ? risky(element) : key === 'Enter' && field ? heavyForm(element.form) : false;
      return { risky: risk, name: name(element) };
    },

    position() {
      const scroller = document.scrollingElement || document.documentElement;
      return { scrollY: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, viewportHeight: window.innerHeight };
    },

    // What the "Add to Dayjob" button saves.
    extract() {
      const job = jobPosting();
      const meta = selector => clean(document.querySelector(selector)?.content || '', 240);
      const main = document.querySelector('main, [role="main"], article') || document.body;
      return {
        url: location.href,
        title: job?.title || clean(document.querySelector('h1')?.innerText || meta('meta[property="og:title"]') || document.title, 240),
        company: job?.company || meta('meta[property="og:site_name"]'),
        location: job?.location || '', remote: job?.remote || false,
        datePosted: job?.datePosted || null, employmentType: job?.employmentType || [],
        description: (job?.description || pageText([main])).slice(0, 100000),
        structured: Boolean(job),
      };
    },
  });
}

exports.PAGE_SOURCE = `(${install.toString()})()`;
