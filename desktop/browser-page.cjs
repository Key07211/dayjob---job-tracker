// Runs inside web pages opened in the Dayjob browser, in an isolated world that
// the page's own scripts cannot reach. Each link, button and field gets a ref
// (e1, e2, …) that stays the same for the life of the document, so Claude can
// read a page once and then act on what it read.
const { HIDDEN_SOURCE } = require('./page-hidden.cjs');
const { PICK_SOURCE } = require('./page-pick.cjs');

// makeHidden: page-hidden.cjs, which says what a page keeps away from the person looking at it.
// pickOption: page-pick.cjs, which says which row of a list some words mean.
function install(makeHidden, pickOption) {
  if (globalThis.dayjobPage) return globalThis.dayjobPage;
  const hidden = makeHidden();
  const refs = new Map();
  const ids = new WeakMap();
  let next = 0;
  const FIELDS = 'a[href], button, input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="searchbox"], '
    + '[role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"], [role="slider"], [role="spinbutton"], [aria-haspopup]:not([aria-haspopup="false"])';
  // What a page lets people click without saying what it is: something the keyboard reaches, or with a click
  // handler written on it. (Whatever shows the hand counts too; see looseControl.)
  const LOOSE = '[tabindex]:not([tabindex^="-"]), [onclick]';
  // The rows of a list that a dropdown or a menu opens.
  const ROWS = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]';
  const loose = new WeakSet();
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
    if (element.isContentEditable) return 'textbox';
    if (loose.has(element)) return 'clickable';
    return element.matches('[aria-haspopup]:not([aria-haspopup="false"])') ? 'button' : tag.toLowerCase();
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
    if (element.type === 'hidden' || hidden(element)) return false;
    const target = clickable(element);
    if (!target.checkVisibility({ visibilityProperty: true })) return false;
    const rect = target.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  // Something to click that the page does not call a control: it shows the hand, the keyboard reaches it, or a click
  // handler is written on it. Only the smallest such box counts (a card around a link is not one), and only one
  // with words on it.
  const wholeText = element => String(element.innerText ?? element.textContent ?? '').trim();
  function looseControl(element) {
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const hand = box => view.getComputedStyle(box).cursor === 'pointer';
    const parent = element.parentElement;
    // The hand is passed down to everything inside, so it counts where it starts.
    if (!element.matches(LOOSE) && !(hand(element) && !(parent && hand(parent)))) return false;
    if (wholeText(element).length > 160) return false;
    if (element.closest(FIELDS) || element.querySelector(`${FIELDS}, ${LOOSE}`)) return false;
    if (element.tagName === 'LABEL' && element.control) return false;
    return Boolean(name(element)) && !namesControl(element);
  }
  // The words beside a checkbox or a radio button take a click too, but they are that control's name and not a
  // second thing to click: they are in its label, or it says it is labelled by them, or the nearest control
  // around reads the same.
  function namesControl(element) {
    if (element.closest('label')?.control) return true;
    const root = element.getRootNode();
    const said = name(element).toLowerCase();
    for (let box = element, depth = 0; box && depth < 6; box = box.parentElement, depth += 1) {
      if (box.id && depth < 3) {
        let named = [];
        try { named = [...root.querySelectorAll(`[aria-labelledby~="${CSS.escape(box.id)}"]`)]; } catch { /* a root that cannot be searched */ }
        if (named.some(control => control.matches(FIELDS))) return true;
      }
      if (box === element) continue;
      const near = box.querySelectorAll(FIELDS);
      if (near.length) return near.length <= 12 && [...near].some(control => name(control).toLowerCase() === said);
    }
    return false;
  }
  // Every control a person could use on the page just now, in page order.
  function controls(found) {
    const list = [];
    let looked = 0;
    for (const root of found) {
      for (const element of root.querySelectorAll('*')) {
        let take = element.matches(FIELDS);
        if (!take && looked < 8000) {
          looked += 1;
          take = looseControl(element);
          if (take) loose.add(element);
        }
        if (take && shown(element)) list.push(element);
      }
    }
    return list;
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
  const choice = element => element.tagName === 'INPUT' && (element.type === 'checkbox' || element.type === 'radio');
  // Whether a click at the point lands on the element: on it, inside it, on its label, or on the see-through
  // input of the same option, which many forms stretch over the label or the drawn button.
  function reaches(element, point, hit) {
    if (!hit) return false;
    const labels = [...(element.labels || [])];
    if (hit === element || hit === point || element.contains(hit) || point.contains(hit) || hit.contains(point) || labels.some(label => label.contains(hit))) return true;
    const label = hit.closest('label');
    if (label && (label.control === element || label.contains(element))) return true;
    if (!choice(hit)) return false;
    // Another input over this option: the option's own, when the two share the box that holds only this option.
    for (let box = hit.parentElement, depth = 0; box && depth < 2; box = box.parentElement, depth += 1) {
      if (!box.contains(point)) continue;
      return !choice(element) && box.querySelectorAll('input[type="checkbox"], input[type="radio"]').length === 1;
    }
    return false;
  }
  const editable = element => element.isContentEditable || element.tagName === 'TEXTAREA'
    || (element.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'range', 'color', ...BUTTON_TYPES].includes(element.type));
  // A field Claude may not type in: a password, a card number or a one-time code. Sites also put
  // autocomplete="one-time-code" or "new-password" on ordinary fields, only to keep the browser's own autofill
  // away from them, so those hints count when the field itself agrees: its words say so, or it is a short box for digits.
  const SECRET_WORDS = /pass(word|code|phrase)?\b|passwd|\bpwd\b|\botp\b|one[- ]?time|verif|\b2fa\b|\bmfa\b|security code|auth\w* code|\bpin\b|\bcvv\b|\bcvc\b|密码|口令|验证码|校验码|动态码/i;
  const hints = element => String(element.getAttribute?.('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const said = element => [name(element), element.id, element.getAttribute('name'), element.getAttribute('placeholder')].filter(Boolean).join(' ');
  const digitBox = element => /^(numeric|decimal)$/.test(element.getAttribute('inputmode') || '') || ['tel', 'number'].includes(element.type) || (element.maxLength > 0 && element.maxLength <= 8);
  function secret(element) {
    if (element.type === 'password') return true;
    const given = hints(element);
    if (given.some(hint => hint.startsWith('cc-'))) return true;
    if (given.includes('one-time-code')) return SECRET_WORDS.test(said(element)) || digitBox(element);
    if (given.includes('current-password') || given.includes('new-password')) return SECRET_WORDS.test(said(element));
    return false;
  }

  // A dropdown the page draws itself: a button that opens a list.
  const opensList = element => !editable(element) && (element.getAttribute('role') === 'combobox' || /^(listbox|menu|tree|grid|true)$/.test(element.getAttribute('aria-haspopup') || ''));
  function value(element) {
    if (element.tagName === 'SELECT') return clean(element.selectedOptions[0]?.text || '', 200);
    if (element.isContentEditable) return textOf(element);
    if (opensList(element)) {
      // What it shows as chosen: its own words, less its label when the label is drawn inside it ("Code +1").
      const label = name(element);
      const drawn = textOf(element);
      if (!drawn || drawn === label) return undefined;
      return clean(drawn.startsWith(`${label} `) ? drawn.slice(label.length) : drawn, 200);
    }
    if (!editable(element) || typeof element.value !== 'string' || !element.value) return undefined;
    return secret(element) ? '(filled)' : clean(element.value, 300);
  }

  // How a control stands: checked, open, pressed, chosen, and what it holds.
  function stateOf(element) {
    const state = {};
    if (choice(element)) state.checked = element.checked;
    else if (element.hasAttribute('aria-checked')) state.checked = element.getAttribute('aria-checked') === 'true';
    for (const [key, attribute] of [['expanded', 'aria-expanded'], ['pressed', 'aria-pressed'], ['selected', 'aria-selected']]) {
      if (element.hasAttribute(attribute)) state[key] = element.getAttribute(attribute) === 'true';
    }
    const current = value(element);
    if (current) state.value = current;
    return state;
  }

  // The question a radio button or a checkbox answers: its group's caption, when the page gives the group one.
  function question(element) {
    const box = element.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (!box) return '';
    const aria = box.getAttribute('aria-label');
    if (aria?.trim()) return clean(aria, 160);
    const labelledBy = box.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = box.getRootNode();
      const joined = labelledBy.split(/\s+/).map(id => textOf(root.getElementById?.(id) || box.ownerDocument.getElementById(id))).filter(Boolean).join(' ');
      if (joined) return clean(joined, 160);
    }
    return box.tagName === 'FIELDSET' ? clean(textOf(box.querySelector(':scope > legend')), 160) : '';
  }

  function describe(element, ref) {
    const item = { ref, role: role(element), name: name(element) };
    if (item.role === 'radio' || item.role === 'checkbox') {
      const group = question(element);
      if (group && group !== item.name) item.group = group;
    }
    if (element.tagName === 'A' && element.href) item.href = element.href.slice(0, 300);
    if (element.tagName === 'INPUT' && item.role === 'textbox' && element.type !== 'text') item.type = element.type;
    const state = stateOf(element);
    // Every row of a list says whether it is the chosen one; only the chosen one is worth the words.
    if (state.selected === false) delete state.selected;
    const { expanded, ...rest } = state;
    Object.assign(item, rest);
    if (element.tagName === 'SELECT') item.options = [...element.options].slice(0, 40).map(option => clean(option.text, 80));
    if (expanded !== undefined) item.expanded = expanded;
    if (opensList(element)) item.opens = 'list';
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

  // What a click brought: before one, everything on show is noted, so that what is on show after it and was not
  // before can be told apart. (A list that was there all along but see-through or without a size was not on show.)
  let before = null;
  function visible(element) {
    if (!element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }
  const came = element => Boolean(before) && !before.has(element) && visible(element);
  // Words on show that no control carries: how a page draws the rows of a list it does not name as one. Each row
  // is given as the first piece of words in it (where a click surely lands on it); line() reads the whole row.
  // onlyNew: rows a click brought, in something that floats over the page (a list that dropped down, not a
  // paragraph that unfolded).
  const rowOf = new WeakMap();
  const line = holder => textOf(rowOf.get(holder) || holder).slice(0, 120);
  function words(found, { onlyNew = false, limit = 400 } = {}) {
    const list = [];
    const seen = new Set();
    const fits = onlyNew ? came : visible;
    const floating = holder => {
      for (let box = holder; box && came(box); box = box.parentElement) {
        if (/^(absolute|fixed)$/.test(box.ownerDocument.defaultView.getComputedStyle(box).position)) return true;
      }
      return false;
    };
    const inLoose = holder => { for (let box = holder; box; box = box.parentElement) if (loose.has(box)) return true; return false; };
    // A box of rows: two or more of its children are made alike and hold words.
    const repeats = box => {
      const kinds = new Set();
      for (const child of box.children) {
        if (!child.textContent.trim()) continue;
        const kind = `${child.tagName} ${child.className?.baseVal ?? child.className}`;
        if (kinds.has(kind)) return true;
        kinds.add(kind);
      }
      return false;
    };
    for (const root of found) {
      const walker = (root.ownerDocument || root).createTreeWalker(root.body || root, 4);
      for (let node = walker.nextNode(); node && list.length < limit; node = walker.nextNode()) {
        const holder = node.parentElement;
        if (!holder || seen.has(holder) || !node.nodeValue.trim()) continue;
        seen.add(holder);
        if (!fits(holder) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'TITLE'].includes(holder.tagName)) continue;
        if (holder.closest(FIELDS) || inLoose(holder) || (onlyNew && !floating(holder))) continue;
        if (hidden(holder) || wholeText(holder).length > 160) continue;
        // The whole row the words are part of ("Menlo Park" and "CA, USA" side by side are one row).
        let row = holder;
        for (let box = row.parentElement; box && box !== root.body && fits(box) && wholeText(box).length <= 160 && !repeats(box) && !box.querySelector(FIELDS); box = row.parentElement) row = box;
        if (row !== holder && seen.has(row)) continue;
        seen.add(row);
        rowOf.set(holder, row);
        list.push(holder);
      }
    }
    return list;
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

  // The same question for a click that names no control: whatever is at a point, or a few words. The words around
  // the spot decide, as far out as they stay a label (a picture inside a "Submit" button says nothing itself).
  function riskyAt(spot, control) {
    if (risky(control)) return true;
    for (let box = spot, depth = 0; box && depth < 6 && !box.matches(FIELDS); box = box.parentElement, depth += 1) {
      const said = wholeText(box);
      if (said.length > 80) break;
      if (RISKY.test(`${said} ${box.getAttribute('aria-label') || ''} ${box.getAttribute('title') || ''}`)) return true;
    }
    return false;
  }

  // What the mouse is about to go for.
  function aim(element) {
    const info = { ref: refFor(element), role: role(element), name: name(element), disabled: disabled(element), risky: riskyAt(element, element), editable: editable(element) };
    // A real checkbox or radio button can also be set without the mouse, so a drawn one that sits under its own
    // picture, or under another option's, is still answered.
    if (choice(element)) { info.choice = element.type; info.checked = element.checked; }
    if (element.hasAttribute('aria-expanded')) info.expanded = element.getAttribute('aria-expanded') === 'true';
    return info;
  }

  // The pointer people watch: an arrow that glides to where the mouse goes, with a ring where it presses. It is
  // drawn over the page, takes no clicks, and leaves a moment after the last move.
  let pointer = null;
  function showPointer(x, y, press) {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!pointer || !pointer.host.isConnected) {
      const host = document.createElement('div');
      host.setAttribute('data-dayjob-pointer', '');
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
      const inside = host.attachShadow({ mode: 'closed' });
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;left:-17px;top:-17px;width:30px;height:30px;border:2px solid #f2b632;border-radius:50%;opacity:0;pointer-events:none';
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      arrow.setAttribute('viewBox', '0 0 24 24');
      arrow.setAttribute('width', '24');
      arrow.setAttribute('height', '24');
      arrow.style.cssText = 'position:fixed;left:-3px;top:-2px;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))';
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', 'M3 2l0 17 4.6-4.2 3 6.6 2.9-1.3-3-6.5 6.1-.4z');
      shape.setAttribute('fill', '#1d2733');
      shape.setAttribute('stroke', '#fff');
      shape.setAttribute('stroke-width', '1.4');
      shape.setAttribute('stroke-linejoin', 'round');
      arrow.append(shape);
      inside.append(ring, arrow);
      document.documentElement.append(host);
      pointer = { host, ring, arrow, x: Math.max(0, x - 90), y: y + 70, timer: 0, fade: null };
    }
    pointer.fade?.cancel();
    pointer.fade = null;
    // Moved with `translate`, which is applied outside `scale`: the ring grows where it stands.
    const from = `${pointer.x}px ${pointer.y}px`;
    const to = `${x}px ${y}px`;
    const far = Math.hypot(x - pointer.x, y - pointer.y);
    const glide = still || far < 2 ? 0 : Math.round(Math.min(320, 140 + far / 4));
    for (const part of [pointer.arrow, pointer.ring]) part.animate([{ translate: from }, { translate: to }], { duration: glide, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
    if (press) {
      pointer.ring.animate([{ opacity: 0, scale: 0.4 }, { opacity: 0.95, scale: 0.6, offset: 0.25 }, { opacity: 0, scale: 1.25 }], { duration: still ? 1 : 520, delay: glide, easing: 'ease-out' });
    }
    pointer.x = x;
    pointer.y = y;
    clearTimeout(pointer.timer);
    const mine = pointer;
    pointer.timer = setTimeout(() => {
      mine.fade = mine.host.animate([{ opacity: 1 }, { opacity: 0 }], { duration: still ? 1 : 260, fill: 'forwards' });
      mine.fade.onfinish = () => { mine.host.remove(); if (pointer === mine) pointer = null; };
    }, 1800);
    return glide;
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
      for (const element of controls(found)) {
        const item = describe(element, refFor(element));
        if (wanted && ![item.name, item.href, item.value].some(text => text?.toLowerCase().includes(wanted))) continue;
        count += 1;
        if (elements.length < maxElements) elements.push(item);
      }
      const text = pageText(found);
      return { title: document.title, text: text.slice(0, maxChars), textTruncated: text.length > maxChars, elements, elementCount: count, otherSiteFrames: frames, jobPosting: jobPosting() };
    },

    // Where to click. An element the mouse already reaches is left where it is (a list that dropped down may close
    // when the page moves under it); any other is scrolled into view first.
    target({ ref }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      const info = aim(element);
      const point = clickable(element);
      const spot = () => {
        const rect = point.getBoundingClientRect();
        const x = rect.left + Math.min(rect.width / 2, 40);
        const y = rect.top + rect.height / 2;
        return { x, y, hit: point.getRootNode().elementFromPoint?.(x, y) || point.ownerDocument.elementFromPoint(x, y) };
      };
      let at = inViewport(point) ? spot() : null;
      if (!at || !reaches(element, point, at.hit)) {
        point.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        at = spot();
        info.moved = true;
      }
      if (!reaches(element, point, at.hit)) info.coveredBy = at.hit ? `${at.hit.tagName.toLowerCase()} “${textOf(at.hit).slice(0, 80) || name(at.hit) || at.hit.className}”` : 'nothing (outside the window)';
      const offset = frameOffset(point);
      return { ...info, x: at.x + offset.x, y: at.y + offset.y };
    },

    // What is at a point of the window (as in a picture of the page): the control there, or the bare thing itself.
    at({ x, y }) {
      let hit = document.elementFromPoint(x, y);
      let left = 0;
      let top = 0;
      for (let depth = 0; hit && depth < 12; depth += 1) {
        // Into open shadow roots and this site's own frames; another site's frame cannot be looked into.
        const inner = hit.shadowRoot?.elementFromPoint(x - left, y - top);
        if (inner && inner !== hit) { hit = inner; continue; }
        if (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME') break;
        let doc = null;
        try { doc = hit.contentDocument; } catch { /* another site */ }
        if (!doc) return { error: 'other-site', src: String(hit.src || '').slice(0, 300) };
        const rect = hit.getBoundingClientRect();
        left += rect.left + hit.clientLeft;
        top += rect.top + hit.clientTop;
        hit = doc.elementFromPoint(x - left, y - top);
      }
      if (!hit) return { error: 'outside' };
      let control = hit.closest(FIELDS);
      for (let box = hit; !control && box; box = box.parentElement) if (loose.has(box) || looseControl(box)) control = box;
      control ||= hit;
      const info = aim(control);
      return { ...info, name: info.name || textOf(hit).slice(0, 120), risky: info.risky || riskyAt(hit, control), x, y };
    },

    // Which control some words on the page belong to: one that reads so, else the words themselves where they
    // stand. Two that read alike are told apart by what a click just brought, then by what is in the window;
    // if that does not settle it, both are named.
    seek({ text }) {
      const want = clean(text, 200).toLowerCase();
      if (!want) return { error: 'no-text' };
      const found = roots().found;
      const pools = [[controls(found), item => name(item) || textOf(item)]];
      pools.push([words(found, { limit: 3000 }), line]);
      let hits = [];
      for (const exact of [true, false]) {
        for (const [pool, said] of pools) {
          const names = pool.map(item => clean(said(item), 200).toLowerCase());
          const index = exact ? names.indexOf(want) : pickOption(names, want);
          if (index < 0) continue;
          hits = pool.filter((item, place) => names[place] === names[index]);
          break;
        }
        if (hits.length) break;
      }
      if (!hits.length) return { error: 'no-text' };
      for (const narrow of [came, inViewport]) {
        const fewer = hits.filter(narrow);
        if (hits.length > 1 && fewer.length) hits = fewer;
      }
      if (hits.length > 1) return { error: 'ambiguous', matches: hits.slice(0, 8).map(item => describe(item, refFor(item))) };
      return { ref: refFor(hits[0]) };
    },

    // Before a click: what is on show now.
    mark() {
      before = new WeakSet();
      for (const root of roots().found) for (const element of root.querySelectorAll('*')) if (visible(element)) before.add(element);
      return true;
    },

    // After a click: how the thing clicked stands now, and what the click brought on show: controls, else the
    // rows of a list that names none.
    changes({ ref, limit = 30 }) {
      const element = ref ? find(ref) : null;
      const found = roots().found;
      const outside = item => !element || !(element === item || element.contains(item));
      let brought = controls(found).filter(item => came(item) && outside(item));
      const plain = !brought.length;
      if (plain) brought = words(found, { onlyNew: true }).filter(outside);
      return { ...(element ? stateOf(element) : { gone: true }), appearedCount: brought.length,
        appeared: brought.slice(0, limit).map(item => (plain ? { ref: refFor(item), role: 'text', name: line(item) } : describe(item, refFor(item)))) };
    },

    // The rows of the list a dropdown drawn by the page has open: those of the list it names, else what came on
    // show since it was clicked. option: the row meant, when one fits. search: a box in the list to type in.
    options({ ref, option = '' }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      const found = roots().found;
      const root = element.getRootNode();
      // The list it names (aria-controls, or aria-owns on the combobox around a field), when that is on show.
      const owner = element.matches('[aria-controls], [aria-owns]') ? element : element.closest('[role="combobox"]') || element;
      const named = ['aria-controls', 'aria-owns'].flatMap(attribute => String(owner.getAttribute(attribute) || '').split(/\s+/)).filter(Boolean)
        .map(id => root.getElementById?.(id) || element.ownerDocument.getElementById(id)).filter(list => list && visible(list));
      const usable = row => row !== element && !element.contains(row) && visible(row) && !hidden(row);
      const everything = controls(found).filter(usable);
      let all = [];
      let rows = [];
      for (const lists of named.length ? [named, []] : [[]]) {
        const within = row => (lists.length ? lists.some(list => list.contains(row)) : came(row));
        all = everything.filter(within);
        rows = all.filter(item => item.matches(ROWS));
        if (!rows.length) {
          rows = all.filter(item => !editable(item) && !['file', 'select'].includes(role(item)));
          rows.push(...words(found, { onlyNew: !lists.length }).filter(holder => usable(holder) && within(holder)));
        }
        if (rows.length) break;
      }
      const names = rows.map(row => clean(rowOf.has(row) ? line(row) : name(row) || textOf(row), 120));
      const index = option ? pickOption(names, option) : -1;
      const search = editable(element) ? null : all.find(item => editable(item) && !secret(item) && !disabled(item) && !item.readOnly);
      return { options: names.slice(0, 40), count: names.length, ...(index >= 0 ? { match: { ref: refFor(rows[index]), name: names[index] } } : {}),
        ...(search ? { search: refFor(search) } : {}), ...stateOf(element) };
    },

    // Shows the pointer on its way to a point; answers how long (ms) it takes to get there.
    pointer({ x, y, press = false }) {
      try { return { wait: showPointer(x, y, press) }; } catch { return { wait: 0 }; }
    },

    // Sets a real checkbox or radio button the way pressing Space on it would, for one the mouse cannot reach.
    toggle({ ref }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      if (!choice(element)) return { error: 'not-choice', role: role(element) };
      if (disabled(element)) return { error: 'disabled' };
      if (!(element.type === 'radio' && element.checked)) element.click();
      return { name: name(element), checked: element.checked };
    },

    focus({ ref, append = false }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      if (!editable(element)) return { error: 'not-editable', role: role(element) };
      if (secret(element)) return { error: 'secret', name: name(element) };
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
      if (!element) return { error: 'missing' };
      return { ...stateOf(element), value: value(element) ?? '' };
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

    // 读岗位: where a link in a list of jobs leads (the link itself, the one around it, or the one inside it).
    link({ ref }) {
      const element = find(ref);
      if (!element) return { error: 'missing' };
      const anchor = element.closest('a[href]') || element.querySelector('a[href]');
      return anchor && /^https?:/i.test(anchor.href) ? { url: anchor.href } : { error: 'no-link', role: role(element), name: name(element) };
    },
    // What a job's own page says about the job, for Dayjob to keep (extract), and whether the page is asking to
    // sign in instead of showing it.
    job() {
      const seen = this.extract();
      const gate = Boolean([...document.querySelectorAll('input[type="password"]')].some(shown));
      return { ...seen, gate };
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

exports.PAGE_SOURCE = `(${install.toString()})(${HIDDEN_SOURCE}, ${PICK_SOURCE})`;
