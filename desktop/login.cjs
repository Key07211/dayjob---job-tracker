// The Dayjob browser's side of the password vault (vault.cjs). This script
// runs in its own isolated world in the page, which the page's own scripts
// cannot reach. It finds a login form (one password box, with the user name
// box before it) or a sign-up form (a new password typed twice), fills a saved
// sign-in into a login form and, for 自动登录, sends it, and reports a password
// the user typed so that Dayjob can offer to keep it.
function installLogin() {
  if (globalThis.dayjobLogin) return globalThis.dayjobLogin;
  // What Dayjob put into each password box, so that it is not offered back.
  const mine = new WeakMap();
  const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const USERISH = /user|email|e-mail|login|account|phone|mobile|账号|用户名|邮箱|手机/i;
  // A button that sends a sign-in, and ones that only look like it (another way to sign in, or to sign up).
  const SENDS = /sign ?in|log ?in|login|continue|next|submit|^go$|登录|登入|继续|下一步|确定|提交/i;
  const ELSEWHERE = /sign ?up|register|create|forgot|reset|google|apple|facebook|microsoft|linkedin|github|sso|passkey|code|magic|subscribe|newsletter|注册|忘记|创建|验证码|订阅/i;
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
    && element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) !== false && !element.closest('[aria-hidden="true"], [inert]');
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
      .filter(button => button.isConnected && button.getBoundingClientRect().width > 0 && !button.closest('[aria-hidden="true"], [inert]') && !ELSEWHERE.test(label(button)));
    const submits = button => box.form && button.form === box.form && (button.tagName === 'INPUT' || (button.type || 'submit') === 'submit');
    return buttons.find(button => submits(button) && SENDS.test(label(button))) || buttons.find(button => SENDS.test(label(button)))
      || (buttons.filter(submits).length === 1 ? buttons.find(submits) : null);
  }
  // Sends a box's form: its button, or the form itself, or Enter in the box (pressed by Dayjob as real input).
  function send(box) {
    const button = sender(box);
    if (button && disabled(button)) return { waiting: true };
    if (button) { button.click(); return { sent: true }; }
    if (box.form) { box.form.requestSubmit(); return { sent: true }; }
    box.focus({ preventScroll: true });
    return { enter: true };
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
  function submit() {
    const found = form();
    if (!found || found.kind !== 'login' || !found.password.value || mine.get(found.password) !== found.password.value) return { sent: false };
    return send(found.password);
  }
  // The first step of a two-step sign-in: the user name, then on to the password page.
  function fillUser({ username }) {
    const box = userStep();
    if (!box || box.value || !username) return { filled: false };
    set(box, username);
    return { filled: true };
  }
  function sendUser() {
    const box = userStep();
    return box?.value ? send(box) : { sent: false };
  }
  return (globalThis.dayjobLogin = { probe, fill, submit, fillUser, sendUser });
}

const LOGIN_SOURCE = `(${installLogin.toString()})()`;
const loginScript = (method, args) => `${LOGIN_SOURCE}.${method}(${args === undefined ? '' : JSON.stringify(args)})`;

module.exports = { loginScript };
