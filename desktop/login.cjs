// The Dayjob browser's side of the password vault (vault.cjs). This script
// runs in its own isolated world in the page, which the page's own scripts
// cannot reach. It finds a login form (one password box, with the user name
// box before it) or a sign-up form (a new password typed twice), fills a saved
// sign-in into a login form and, for 自动登录, sends it, and reports a password
// the user typed so that Dayjob can offer to keep it. For an account the
// assistant creates (注册新账户) it puts a password Dayjob made up into the
// sign-up form's password boxes.
// For 邮箱验证码 it finds the box a site shows for a code it sent by mail, and
// puts in the code Dayjob read from the user's mail.
const { HIDDEN_SOURCE } = require('./page-hidden.cjs');

// makeHidden: page-hidden.cjs, which says what a page keeps away from the person looking at it.
function installLogin(makeHidden) {
  if (globalThis.dayjobLogin) return globalThis.dayjobLogin;
  const hidden = makeHidden();
  // What Dayjob put into each password box, so that it is not offered back.
  const mine = new WeakMap();
  const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const USERISH = /user|email|e-mail|login|account|phone|mobile|账号|用户名|邮箱|手机/i;
  // A button that sends a sign-in, and ones that only look like it (another way to sign in, or to sign up).
  const SENDS = /sign ?in|log ?in|login|continue|next|submit|^go$|登录|登入|继续|下一步|确定|提交/i;
  const ELSEWHERE = /sign ?up|register|create|forgot|reset|google|apple|facebook|microsoft|linkedin|github|sso|passkey|code|magic|subscribe|newsletter|注册|忘记|创建|验证码|订阅/i;
  // What says a form creates an account, and what says it signs in to one.
  const SIGNS_UP = /sign[ -]?up|register|registration|create (an |a |your |my |new )*account|join (us|now)|get started|new (user|account)|注册|创建账[号户]|新用户|新账[号户]/i;
  const SIGNS_IN = /sign[ -]?in|log[ -]?in|登录|登入/i;
  const EMAILISH = /e-?mail|邮箱|电子邮件/i;
  const NAMEISH = /user|login|account|用户名|账号/i;
  // The first step of a two-step sign-in is only filled on a page that says it is about signing in.
  const SIGNIN_PAGE = /log[ _-]?in|sign[ _-]?in|signin|auth|account|identifier|sso|登录|登入/i;

  function roots() {
    const found = [];
    const visit = root => {
      found.push(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot);
        if (element.tagName !== 'IFRAME' && element.tagName !== 'FRAME') continue;
        let inner = null;
        try { inner = element.contentDocument; } catch { /* another site's frame is never filled */ }
        if (inner?.documentElement) visit(inner);
      }
    };
    visit(document);
    return found;
  }
  const usable = element => element.isConnected && !element.disabled && !element.readOnly && element.getBoundingClientRect().width > 0
    && element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) !== false && !hidden(element);
  const describe = element => `${element.name} ${element.id} ${element.placeholder} ${element.getAttribute('aria-label') || ''} ${[...(element.labels || [])].map(label => label.innerText).join(' ')}`;

  function userBox(password, scope) {
    const boxes = [...scope.querySelectorAll('input')].filter(input => usable(input) && ['text', 'email', 'tel'].includes(input.type)
      && (input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING));
    return boxes.find(input => /username|email/.test(input.autocomplete || '')) || boxes.reverse().find(input => USERISH.test(describe(input))) || boxes[0] || null;
  }
  const disabled = element => element.disabled || element.getAttribute('aria-disabled') === 'true';
  const label = element => clean(element.innerText || element.value || element.getAttribute('aria-label') || element.title || '', 80);
  // The button that sends the form a box is in: the form's own submit button, or one named like signing in.
  function sender(box) {
    const scope = box.form || box.closest('[role="form"], [role="dialog"], section, main') || box.getRootNode();
    const buttons = [...scope.querySelectorAll('button, input[type="submit"], input[type="image"], [role="button"]')]
      .filter(button => button.isConnected && button.getBoundingClientRect().width > 0 && !hidden(button) && !ELSEWHERE.test(label(button)));
    const submits = button => box.form && button.form === box.form && (button.tagName === 'INPUT' || (button.type || 'submit') === 'submit');
    return buttons.find(button => submits(button) && SENDS.test(label(button))) || buttons.find(button => SENDS.test(label(button)))
      || (buttons.filter(submits).length === 1 ? buttons.find(submits) : null);
  }
  // Where the mouse can press a button: a point of it in the window with nothing lying over it, after a scroll
  // when it was out of view (moved). null: the mouse cannot get to it from here.
  function spot(button) {
    const look = () => {
      const rect = button.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) return null;
      const view = button.ownerDocument.defaultView;
      const x = rect.left + Math.min(rect.width / 2, 40);
      const y = rect.top + rect.height / 2;
      if (x < 1 || y < 1 || x > view.innerWidth - 1 || y > view.innerHeight - 1) return { out: true };
      const root = button.getRootNode();
      const hit = (root.elementFromPoint ? root : button.ownerDocument).elementFromPoint(x, y);
      if (!hit || !(hit === button || button.contains(hit))) return null;
      let left = 0;
      let top = 0;
      for (let inner = view; inner !== window;) {
        const frame = inner.frameElement;
        if (!frame) return null;
        const box = frame.getBoundingClientRect();
        left += box.left + frame.clientLeft;
        top += box.top + frame.clientTop;
        inner = frame.ownerDocument.defaultView;
      }
      return { x: x + left, y: y + top };
    };
    let at = look();
    let moved = false;
    if (at?.out) {
      button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      moved = true;
      at = look();
    }
    return at && !at.out ? { x: at.x, y: at.y, moved } : null;
  }
  // Sends a box's form: its button, or the form itself, or Enter in the box (pressed by Dayjob as real input).
  // mouse: the button is not pressed here; where it is comes back (at), for the mouse to press it as a hand
  // would, and the press is listened for (see pressed). A button the mouse cannot get to is pressed by command.
  let armed = null;
  function send(box, how = {}) {
    const button = sender(box);
    if (button && disabled(button)) return { waiting: true };
    if (button) {
      const at = how.mouse ? spot(button) : null;
      if (at) {
        const heard = (armed = { button, pressed: false });
        button.addEventListener('click', event => { if (event.isTrusted) heard.pressed = true; }, { capture: true, once: true });
        return { at };
      }
      button.click();
      return { sent: true };
    }
    if (box.form) { box.form.requestSubmit(); return { sent: true }; }
    box.focus({ preventScroll: true });
    return { enter: true };
  }
  // After the mouse: a button its press did not reach is pressed by command, so that the form is sent once either
  // way. On a page that has moved on since, nothing is pressed.
  function pressed() {
    const was = armed;
    armed = null;
    if (!was) return { sent: false, gone: true };
    if (was.pressed) return { sent: true, by: 'mouse' };
    if (!was.button.isConnected || disabled(was.button)) return { sent: true, by: 'unknown' };
    was.button.click();
    return { sent: true, by: 'command' };
  }
  // The login or sign-up form on the page, if there is one.
  function form() {
    for (const root of roots()) {
      for (const password of root.querySelectorAll('input[type="password"]')) {
        if (!usable(password)) continue;
        const scope = password.form || password.closest('[role="form"], [role="dialog"], section, main') || root;
        const boxes = [...scope.querySelectorAll('input[type="password"]')].filter(usable);
        if (boxes.length > 2) continue;
        const signup = boxes.length === 2 || password.autocomplete === 'new-password';
        return { kind: signup ? 'signup' : 'login', password: boxes[0], again: boxes[1] || null, user: userBox(boxes[0], scope) };
      }
    }
    return null;
  }
  // 注册新账户. The box of a sign-up form that names the account: its email, else its user name; never a phone
  // number or a person's name, which a sign-up form also asks for.
  function accountBox(password, scope) {
    const boxes = [...scope.querySelectorAll('input')].filter(input => usable(input) && ['text', 'email'].includes(input.type)
      && (input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING));
    return boxes.find(input => /username|email/.test(input.autocomplete || '')) || boxes.find(input => input.type === 'email' || EMAILISH.test(describe(input)))
      || boxes.find(input => NAMEISH.test(describe(input))) || null;
  }
  // Whether a form creates an account. One that asks for the password twice, or calls it new, does. One with a
  // single plain password box does only when its own button says so, or the page does and its button does not
  // say it signs in.
  function creates(found) {
    if (found.kind === 'signup') return true;
    const scope = found.password.form || found.password.closest('[role="form"], [role="dialog"], section, main') || found.password.getRootNode();
    const buttons = [...scope.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(button => button.isConnected && button.getBoundingClientRect().width > 0 && !hidden(button));
    const own = buttons.filter(button => !found.password.form || button.form === found.password.form).filter(button => button.tagName === 'INPUT' || (button.type || 'submit') === 'submit');
    const says = (own.length ? own : buttons).map(label).join(' | ');
    if (SIGNS_UP.test(says)) return true;
    if (SIGNS_IN.test(says)) return false;
    const heading = clean([...scope.querySelectorAll('h1, h2, h3, legend')].map(item => item.innerText).join(' ') || document.querySelector('h1')?.innerText || '', 300);
    const about = `${heading} ${document.title} ${location.pathname}`;
    return SIGNS_UP.test(about) && !SIGNS_IN.test(heading);
  }
  // What Dayjob needs to know before it makes a password up: is this a sign-up form, which account it is for, and
  // how long a password its box takes.
  function signup() {
    const found = form();
    if (!found) return { form: null };
    const user = accountBox(found.password, found.password.form || found.password.closest('[role="form"], [role="dialog"], section, main') || found.password.getRootNode());
    const size = name => { const value = Number(found.password.getAttribute(name)); return Number.isInteger(value) && value > 0 ? value : null; };
    return { form: found.kind, creates: creates(found), userBox: Boolean(user), username: clean(user?.value), min: size('minlength'), max: size('maxlength'), boxes: found.again ? 2 : 1 };
  }
  // Puts the new password into the sign-up form's password box, and the box that asks for it again.
  function setNew({ password }) {
    const found = form();
    if (!found || !creates(found)) return { set: false };
    for (const box of [found.password, found.again].filter(Boolean)) {
      set(box, password);
      mine.set(box, password);
      box.blur();
    }
    return { set: found.password.value === password && (!found.again || found.again.value === password), boxes: found.again ? 2 : 1 };
  }
  // A user name typed on a page without a password box: the first step of a two-step sign-in.
  function loneUser() {
    for (const root of roots()) {
      for (const input of root.querySelectorAll('input')) {
        if (!usable(input) || !['text', 'email', 'tel'].includes(input.type) || !input.value) continue;
        if (/username|email/.test(input.autocomplete || '') || input.type === 'email' || USERISH.test(describe(input))) return clean(input.value);
      }
    }
    return '';
  }
  // The user name box of a two-step sign-in's first step: the only box in its form, asking for a user name or
  // email, with a button to go on, on a page about signing in; never a newsletter or search box.
  function userStep() {
    if (!SIGNIN_PAGE.test(`${location.pathname} ${location.hostname} ${document.title}`)) return null;
    const boxes = [...document.querySelectorAll('input')].filter(input => usable(input) && !['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'file'].includes(input.type));
    const box = boxes.find(input => /username|email/.test(input.autocomplete || '') || input.type === 'email' || (['text', 'tel'].includes(input.type) && USERISH.test(describe(input))));
    if (!box || /search/i.test(`${box.type} ${describe(box)}`)) return null;
    const scope = box.form || box.closest('[role="form"], [role="dialog"], section, main');
    if (!scope || boxes.filter(input => scope.contains(input)).length !== 1 || !sender(box)) return null;
    return box;
  }
  function probe() {
    const found = form();
    if (!found) {
      const step = userStep();
      return { form: null, user: loneUser(), step: step ? (step.value ? 'typed' : 'empty') : null };
    }
    const { kind, password, again, user } = found;
    const value = password.value;
    const typed = value && mine.get(password) !== value && (!again || again.value === value) ? { username: clean(user?.value), password: value } : null;
    return { form: kind, empty: !value, filledByDayjob: mine.has(password), typed };
  }
  function set(element, value) {
    element.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    if (setter) setter.call(element, value); else element.value = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    try { element.animate([{ boxShadow: '0 0 0 3px rgba(18, 130, 94, 0.55)' }, { boxShadow: '0 0 0 3px rgba(18, 130, 94, 0)' }], { duration: 1800 }); } catch { /* cosmetic */ }
  }
  // Into a login form only; a box that has something in it is left alone
  // unless the user picked this sign-in themselves.
  function fill({ username, password, replace }) {
    const found = form();
    if (!found || found.kind !== 'login' || (found.password.value && !replace)) return { filled: false };
    if (found.user && username && (replace || !found.user.value)) set(found.user, username);
    set(found.password, password);
    mine.set(found.password, password);
    found.password.blur();
    return { filled: true };
  }
  // 自动登录: sends the login form, but only while it still holds the password Dayjob put in.
  function submit(how = {}) {
    if (how.check) return pressed();
    const found = form();
    if (!found || found.kind !== 'login' || !found.password.value || mine.get(found.password) !== found.password.value) return { sent: false };
    return send(found.password, how);
  }
  // The first step of a two-step sign-in: the user name, then on to the password page.
  function fillUser({ username }) {
    const box = userStep();
    if (!box || box.value || !username) return { filled: false };
    set(box, username);
    return { filled: true };
  }
  function sendUser(how = {}) {
    if (how.check) return pressed();
    const box = userStep();
    return box?.value ? send(box, how) : { sent: false };
  }
  // ---------- 邮箱验证码 ----------
  // The box for a code a site sent (a "verification code", a "one-time code"): one box, or a row of boxes that
  // take one character each. A box that only says "code" counts when what stands around it is about verifying;
  // a postal, country or promo code never does.
  const CODE_SURE = /\botp\b|one[- ]?time|verif|\b2fa\b|\bmfa\b|pass ?code|(security|auth\w*|confirmation|access|login|sign[- ]?in|e-?mail) code|验证码|校验码|动态码|确认码/i;
  const CODE_PLAIN = /\bcode\b|\bpin\b/i;
  const CODE_OTHER = /zip|postal|post ?code|country|area|dial|promo|coupon|voucher|discount|referr|invit|邮编|邮政|区号|优惠|邀请|推荐/i;
  const CODE_ABOUT = /verif|one[- ]?time|confirm your|we('ve| have)? (just )?(sent|e-?mailed)|sent (you )?(a|an|the)|check your (e-?mail|inbox)|enter the code|验证|已发送|发送到|查收/i;
  const BY_MAIL = /e-?mail|inbox|邮箱|邮件/i;
  const BY_OTHER = /\bsms\b|text message|texted|\bphone\b|\bmobile\b|authenticator|auth\w* app|短信|手机|验证器/i;
  const around = box => {
    const scope = box.form || box.closest('[role="dialog"], [role="form"], section, main') || document.body;
    return clean(`${scope?.innerText || ''} ${document.querySelector('h1')?.innerText || ''} ${document.title}`, 1500);
  };
  function codeBoxes() {
    const inputs = roots().flatMap(root => [...root.querySelectorAll('input')])
      .filter(input => usable(input) && (['text', 'tel', 'number', ''].includes(input.type) || (input.type === 'password' && /one-time-code/.test(input.autocomplete || ''))));
    // A row of one-character boxes: four to eight of them side by side in one form.
    const ones = inputs.filter(input => input.maxLength === 1);
    for (const first of ones) {
      const scope = first.form || first.parentElement?.parentElement || first.parentElement;
      const row = ones.filter(input => scope?.contains(input));
      if (row.length >= 4 && row.length <= 8 && (CODE_SURE.test(around(first)) || CODE_ABOUT.test(around(first)))) return { kind: 'row', boxes: row };
    }
    const one = inputs.find(input => {
      if (input.maxLength === 1 || input.type === 'email') return false;
      const says = describe(input);
      if (/one-time-code/.test(input.autocomplete || '')) return true;
      if (CODE_OTHER.test(says)) return false;
      return CODE_SURE.test(says) || (CODE_PLAIN.test(says) && CODE_ABOUT.test(around(input)));
    });
    return one ? { kind: 'one', boxes: [one] } : null;
  }
  // What Dayjob needs to know before it reads the user's mail: is there such a box, how long a code it takes, is
  // it empty, and does the page say the code came by mail (mail) or some other way (other: a phone, an app).
  function code() {
    const found = codeBoxes();
    if (!found) return { box: false };
    const about = around(found.boxes[0]);
    const max = found.kind === 'row' ? found.boxes.length : found.boxes[0].maxLength > 0 ? found.boxes[0].maxLength : null;
    return { box: true, kind: found.kind, count: found.boxes.length, length: max, filled: found.boxes.some(box => box.value), mail: BY_MAIL.test(about), other: BY_OTHER.test(about) };
  }
  // Puts the code in: whole into the one box, or a character into each box of the row. A code that does not fit
  // the box is not put in at all.
  function setCode({ code: value }) {
    const found = codeBoxes();
    const text = String(value || '');
    if (!found || !text) return { set: false, why: 'no-field' };
    if (found.boxes.some(box => box.value)) return { set: false, why: 'typed' };
    if (found.kind === 'row') {
      if (text.length !== found.boxes.length) return { set: false, why: 'length' };
      found.boxes.forEach((box, index) => set(box, text[index]));
      found.boxes[found.boxes.length - 1].blur();
      return { set: found.boxes.every((box, index) => box.value === text[index]), boxes: found.boxes.length };
    }
    const [box] = found.boxes;
    if (box.maxLength > 0 && text.length > box.maxLength) return { set: false, why: 'length' };
    if (box.type === 'number' && !/^\d+$/.test(text)) return { set: false, why: 'length' };
    set(box, text);
    box.blur();
    return { set: box.value === text, boxes: 1 };
  }
  return (globalThis.dayjobLogin = { probe, fill, submit, fillUser, sendUser, signup, setNew, code, setCode });
}

const LOGIN_SOURCE = `(${installLogin.toString()})(${HIDDEN_SOURCE})`;
const loginScript = (method, args) => `${LOGIN_SOURCE}.${method}(${args === undefined ? '' : JSON.stringify(args)})`;

module.exports = { loginScript };
