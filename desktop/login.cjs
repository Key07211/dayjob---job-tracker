// The Dayjob browser's side of the password vault (vault.cjs). This script
// runs in its own isolated world in the page, which the page's own scripts
// cannot reach. It finds a login form (one password box, with the user name
// box before it) or a sign-up form (a new password typed twice), fills a saved
// sign-in into a login form, and reports a password the user typed so that
// Dayjob can offer to keep it.
function installLogin() {
  if (globalThis.dayjobLogin) return globalThis.dayjobLogin;
  // What Dayjob put into each password box, so that it is not offered back.
  const mine = new WeakMap();
  const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const USERISH = /user|email|e-mail|login|account|phone|mobile|账号|用户名|邮箱|手机/i;

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
  function probe() {
    const found = form();
    if (!found) return { form: null };
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
  return (globalThis.dayjobLogin = { probe, fill });
}

const LOGIN_SOURCE = `(${installLogin.toString()})()`;
const loginScript = (method, args) => `${LOGIN_SOURCE}.${method}(${args === undefined ? '' : JSON.stringify(args)})`;

module.exports = { loginScript };
