// 自动填写 (autofill) for application forms in the Dayjob browser. A small
// script lists each frame's form fields with their labels; the matching to the
// user's application profile happens here, outside the page, and each frame
// is sent only the values for its own matched fields.

// Runs in the page: in an isolated world for the top frame (which also reaches
// same-site frames and open shadow roots), and in other sites' frames directly,
// under a name chosen for each run so the page cannot stand in for it.
function installAutofill(name) {
  if (globalThis[name]) return globalThis[name];
  let registry = [];
  const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const textOf = node => clean(node?.innerText || node?.textContent || '', 300);
  const SUBMIT = /\b(submit|send)\b.*\b(application|applications)?\b|\bapply( now)?\b|提交|投递/i;
  const BUTTON_TYPES = ['submit', 'button', 'reset', 'image'];

  function roots() {
    const found = [];
    const visit = root => {
      found.push(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot);
        if (element.tagName !== 'IFRAME' && element.tagName !== 'FRAME') continue;
        let inner = null;
        try { inner = element.contentDocument; } catch { /* another site: scanned on its own */ }
        if (inner?.documentElement) visit(inner);
      }
    };
    visit(document);
    return found;
  }
  function visible(element) {
    if (element.type === 'hidden' || element.closest('[aria-hidden="true"], [inert]')) return false;
    if (!element.checkVisibility?.({ visibilityProperty: true })) {
      // Custom radios and checkboxes hide the input and show its label.
      const label = element.labels?.[0];
      if (!label || !label.checkVisibility?.({ visibilityProperty: true })) return false;
    }
    return true;
  }
  const disabled = element => Boolean(element.disabled || element.readOnly || element.getAttribute('aria-disabled') === 'true');

  // The text a person reads as the field's question.
  function ownLabel(element) {
    const parts = [];
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) parts.push(labelledBy.split(/\s+/).map(id => textOf(element.getRootNode().getElementById?.(id) || element.ownerDocument.getElementById(id))).join(' '));
    if (element.labels?.length) parts.push([...element.labels].map(textOf).join(' '));
    if (element.getAttribute('aria-label')) parts.push(element.getAttribute('aria-label'));
    return clean(parts.filter(Boolean).join(' '));
  }
  // The nearest container that holds only this field (or this group) and some text.
  function containerText(element, group) {
    let node = element.parentElement;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const fields = [...node.querySelectorAll('input, select, textarea')].filter(field => field.type !== 'hidden');
      if (fields.some(field => !group.includes(field))) break;
      const legend = node.tagName === 'FIELDSET' ? textOf(node.querySelector('legend')) : '';
      if (legend) return legend;
      let text = textOf(node);
      for (const field of group) for (const label of field.labels || []) text = text.replace(textOf(label), ' ');
      text = clean(text);
      if (text) return text;
    }
    return '';
  }
  // A label just before the field, or before the box that holds only this
  // field, that is not tied to another control.
  function nearbyLabel(element) {
    let node = element;
    for (let depth = 0; node && depth < 3; depth += 1) {
      for (let sibling = node.previousElementSibling, step = 0; sibling && step < 3; sibling = sibling.previousElementSibling, step += 1) {
        if (sibling.matches('input, select, textarea, button') || sibling.querySelector('input, select, textarea')) return '';
        if (sibling.tagName === 'LABEL') return sibling.control && sibling.control !== element ? '' : textOf(sibling);
        if (/[*?:：？]\s*$/.test(textOf(sibling))) return textOf(sibling);
      }
      const parent = node.parentElement;
      if (!parent || [...parent.querySelectorAll('input, select, textarea')].some(field => field !== element && field.type !== 'hidden')) return '';
      node = parent;
    }
    return '';
  }
  // The heading of the part of the form a field is in, such as "Education" or
  // "Work Experience 2": the nearest heading before it, or a named group around it.
  const HEADING = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';
  function sectionOf(element) {
    let node = element;
    for (let depth = 0; node?.parentElement && depth < 10; depth += 1) {
      if (/^(group|region)$/.test(node.getAttribute('role') || '')) {
        const by = node.getAttribute('aria-labelledby');
        const named = node.getAttribute('aria-label') || (by ? by.split(/\s+/).map(id => textOf(element.ownerDocument.getElementById(id))).join(' ') : '');
        if (clean(named)) return clean(named, 80);
      }
      for (let sibling = node.previousElementSibling, step = 0; sibling && step < 15; sibling = sibling.previousElementSibling, step += 1) {
        const heading = sibling.matches(HEADING) ? sibling : [...sibling.querySelectorAll(HEADING)].pop();
        if (heading) return clean(textOf(heading), 80);
      }
      node = node.parentElement;
    }
    return '';
  }
  function describe(element, group = [element]) {
    const own = group.length > 1 ? '' : ownLabel(element) || nearbyLabel(element);
    const question = group.length > 1 || !own ? containerText(element, group) : '';
    return {
      label: clean(own || question || element.getAttribute('placeholder') || element.getAttribute('title') || '').replace(/\s*\*$/, ''),
      section: sectionOf(element),
      name: clean(element.getAttribute('name') || ''), id: clean(element.id || ''),
      placeholder: clean(element.getAttribute('placeholder') || ''), autocomplete: clean(element.getAttribute('autocomplete') || '', 60),
      required: group.some(field => field.required || field.getAttribute('aria-required') === 'true') || /\*\s*$/.test(own || question),
    };
  }
  const placeholderOption = option => !option.value || /^(select|choose|please|--|—|-)/i.test(clean(option.text));

  function scan() {
    registry = [];
    const fields = [];
    const groups = new Map();
    for (const root of roots()) {
      for (const element of root.querySelectorAll('input, select, textarea')) {
        if (!visible(element) || disabled(element)) continue;
        const type = element.tagName === 'INPUT' ? (element.type || 'text').toLowerCase() : element.tagName.toLowerCase();
        if (BUTTON_TYPES.includes(type) || ['password', 'range', 'color', 'search'].includes(type)) continue;
        if (/^cc-|one-time-code|new-password|current-password/.test(element.autocomplete || '')) continue;
        if (type === 'radio') {
          const key = `${element.form ? 'form' : 'doc'}:${element.name || Math.random()}`;
          if (!groups.has(key)) {
            groups.set(key, []);
            fields.push({ group: key });
          }
          groups.get(key).push(element);
          continue;
        }
        const index = registry.push([element]) - 1;
        const item = { index, kind: type === 'select' ? 'select' : type === 'checkbox' ? 'checkbox' : type === 'file' ? 'file' : 'text', type, ...describe(element) };
        if (type === 'select') {
          item.options = [...element.options].map(option => clean(option.text, 120));
          item.filled = element.selectedIndex >= 0 && !placeholderOption(element.options[element.selectedIndex]);
        } else if (type === 'checkbox') item.filled = element.checked;
        else if (type === 'file') item.filled = element.files?.length > 0;
        else item.filled = Boolean(clean(element.value));
        fields.push(item);
      }
    }
    return fields.map(item => {
      if (!item.group) return item;
      const group = groups.get(item.group);
      const index = registry.push(group) - 1;
      return { index, kind: 'radio', type: 'radio', ...describe(group[0], group), options: group.map(radio => clean(ownLabel(radio) || radio.value, 120)), filled: group.some(radio => radio.checked) };
    });
  }

  const setter = element => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  const glow = element => { try { element.animate([{ boxShadow: '0 0 0 3px rgba(18, 130, 94, 0.55)' }, { boxShadow: '0 0 0 3px rgba(18, 130, 94, 0)' }], { duration: 1800 }); } catch { /* cosmetic */ } };
  function fill(items) {
    let filled = 0;
    for (const item of items) {
      const group = registry[item.index];
      const element = group?.[0];
      if (!element?.isConnected) continue;
      if (typeof item.value === 'string') {
        element.focus({ preventScroll: true });
        const set = setter(element);
        if (set) set.call(element, item.value); else element.value = item.value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: item.value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new FocusEvent('blur'));
        element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        glow(element);
        filled += 1;
      } else if (Number.isInteger(item.option) && element.tagName === 'SELECT' && element.options[item.option]) {
        element.selectedIndex = item.option;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        glow(element);
        filled += 1;
      } else if (item.check === true && element.type === 'checkbox') {
        if (!element.checked) element.click();
        glow(element.labels?.[0] || element);
        filled += 1;
      } else if (Number.isInteger(item.option) && group[item.option]?.type === 'radio') {
        group[item.option].click();
        glow(group[item.option].labels?.[0] || group[item.option]);
        filled += 1;
      }
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    return { filled };
  }

  // The button that sends the form most of the fields belong to.
  function submitButton() {
    const counts = new Map();
    for (const [element] of registry) if (element.form) counts.set(element.form, (counts.get(element.form) || 0) + 1);
    const form = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const candidates = [];
    for (const root of roots()) {
      for (const button of root.querySelectorAll('button, input[type="submit"], input[type="image"], [role="button"]')) {
        if (!visible(button) || disabled(button)) continue;
        const name = clean(button.innerText || button.value || button.getAttribute('aria-label') || '', 80);
        const submits = (button.tagName === 'BUTTON' && (button.type || 'submit') === 'submit') || button.tagName === 'INPUT';
        const score = (form && button.form === form ? 4 : 0) + (submits ? 2 : 0) + (SUBMIT.test(name) ? 3 : 0);
        if (score >= 3) candidates.push({ button, name, score });
      }
    }
    return candidates.sort((a, b) => b.score - a.score)[0] || null;
  }
  function submit() {
    const found = submitButton();
    if (!found) return { error: 'no-button' };
    found.button.scrollIntoView({ block: 'center', behavior: 'instant' });
    found.button.click();
    return { clicked: found.name };
  }
  function confirmation() {
    const text = (document.body?.innerText || '').slice(0, 20000);
    return /thank(s| you)[^.]{0,60}(appl|submi|interest)|application (has been |was )?(submitted|received|sent)|we('ve| have) received your application|successfully (submitted|applied)|申请已(提交|收到)|投递成功|感谢您的申请/i.test(text);
  }

  return (globalThis[name] = { scan, fill, submit, confirmation });
}

// ---------- matching, outside the page ----------

const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming' };
const COUNTRY_NAMES = [
  ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.', 'america', '美国'],
  ['china', "people's republic of china", 'prc', 'mainland china', '中国'],
  ['united kingdom', 'uk', 'u.k.', 'great britain', 'england', '英国'],
  ['canada', '加拿大'], ['india', '印度'], ['hong kong', 'hong kong sar', '香港'], ['taiwan', '台湾'], ['singapore', '新加坡'],
];

// Which profile entry a field asks for. Earlier rules win, so the specific
// ones ("email address", "preferred name") come before the general ones.
const RULES = [
  ['email', /e-?mail|邮箱|电子邮件/],
  ['phone', /phone|mobile|telephone|\bcell\b|手机|电话/],
  ['linkedin', /linked ?in/],
  ['github', /git ?hub/],
  ['website', /website|portfolio|personal (site|url|page|link)|\bblog\b|个人网站|作品集/],
  ['preferredName', /preferred (first )?name|nick ?name/],
  ['firstName', /first name|given name|forename|^f ?name$|名字/],
  ['lastName', /last name|family name|surname|^l ?name$|姓氏/],
  ['fullName', /full name|legal name|your name|^name\b|姓名/],
  ['postalCode', /\bzip\b|postal|post code|邮编/],
  ['address', /street|address line|^address\b|mailing address|home address|地址/],
  ['city', /\bcity\b|\btown\b|城市/],
  ['state', /\bstate\b|province|\bregion\b|省份/],
  ['country', /country|国家/],
  ['location', /location|where (are you|do you) (currently )?(located|based|live)|currently (located|based|reside)|所在地/],
  ['gpa', /\bgpa\b|grade point|绩点/],
  ['school', /school|university|college|institution|学校|大学/],
  ['degree', /degree|学位|学历/],
  ['major', /\bmajor\b|field of study|discipline|concentration|专业/],
  ['graduation', /graduat|毕业/],
  ['currentCompany', /current (company|employer)|most recent (company|employer)|现(在的)?公司/],
  ['company', /^(company|employer)( name)?$/],
  ['currentTitle', /current (job )?(title|role|position)|most recent (job )?(title|role)/],
  ['title', /^(job )?title$|职位|职称/],
  ['yearsExperience', /years? of (professional |relevant |work |industry )?experience|how many years|工作年限/],
  ['authorizedWithoutSponsorship', /without (the need for |requiring |needing )?(visa )?sponsor/],
  ['needsSponsorship', /sponsor/],
  ['workAuthorized', /authori[sz]ed to work|work authori[sz]ation|eligible to work|right to work|legally (able|permitted|allowed) to work|工作许可/],
  ['willingToRelocate', /relocat|搬迁/],
  ['salary', /salary|compensation|pay (expectation|range|requirement)|desired pay|薪资|薪酬|期望工资/],
  ['startDate', /start date|available to start|availability|notice period|when (can|could) you (start|begin)|earliest start|入职/],
  ['heardFrom', /how did you (hear|find|learn|come across)|where did you (hear|find|learn|see)|referral source|从哪里(得知|了解)/],
  ['coverLetter', /cover letter|求职信/],
  ['eeoGender', /gender|\bsex\b|性别/],
  ['eeoRace', /\brace\b|ethnicity|hispanic|latin[ox]/],
  ['eeoVeteran', /veteran/],
  ['eeoDisability', /disabilit/],
];
// Inside a form's Education or Work Experience part, its fields are about
// one school or job each; the nth such part takes the nth entry.
const EDUCATION_PART = /education|academic|学历|教育/;
const EXPERIENCE_PART = /experience|employment|work history|job history|career history|工作经历|工作经验|实习经历/;
const PART_RULES = {
  education: [
    ['gpa', /\bgpa\b|grade point|grade average|绩点/],
    ['school', /school|university|college|institution|学校|大学|院校/],
    ['degree', /degree|学位|学历/],
    ['major', /major|field of study|discipline|concentration|subject|专业/],
    ['eduStart', /\bfrom\b|start|begin|入学|开始/],
    ['graduation', /\bto\b|\bend\b|graduat|until|complet|毕业|结束/],
  ],
  experience: [
    ['workSummary', /descri|responsibilit|summary|achievement|duties|accomplishment|职责|工作内容|描述/],
    ['company', /company|employer|organi[sz]ation|公司|单位/],
    ['title', /title|position|role|职位|职称|岗位/],
    ['workLocation', /location|city|地点|城市/],
    ['workStart', /\bfrom\b|start|begin|开始|入职/],
    ['workEnd', /\bto\b|\bend\b|until|离职|结束/],
  ],
};
const DATE_KEYS = ['eduStart', 'graduation', 'workStart', 'workEnd'];
const ENTRY_KEYS = { school: 'education', degree: 'education', major: 'education', gpa: 'education', eduStart: 'education', graduation: 'education',
  company: 'experience', title: 'experience', workLocation: 'experience', workStart: 'experience', workEnd: 'experience', workSummary: 'experience', workCurrent: 'experience' };

// Fields about someone else, or ones Dayjob should never guess.
const SKIP = /emergency|reference|referee|recruiter|hiring manager|\breferr(er|ed)\b|referral('?s)? (name|email|phone)|employee('?s)? (name|email)|captcha|password|signature|签名/;
const YES_NO_KEYS = ['needsSponsorship', 'workAuthorized', 'willingToRelocate', 'authorizedWithoutSponsorship'];
const DECLINE = /decline|prefer not|don.?t wish|do not wish|not wish to|rather not|choose not|not to (answer|disclose|say|self.?identify)|i don.?t want|不愿|不透露/;

const words = value => String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-[\]().:*?]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const norm = value => words(value).replace(/[^\p{L}\p{N} ]/gu, '').trim();

// The Education or Work Experience part of a form a field is in, if any.
function partOf(field) {
  const where = words(`${field.section || ''} ${field.name} ${field.id}`);
  return EDUCATION_PART.test(where) ? 'education' : EXPERIENCE_PART.test(where) ? 'experience' : null;
}

function keyFor(field) {
  const autocomplete = (field.autocomplete || '').toLowerCase().split(/\s+/).pop();
  const byAutocomplete = { 'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', nickname: 'preferredName', email: 'email', tel: 'phone',
    'tel-national': 'phone', 'street-address': 'address', 'address-line1': 'address', 'address-level2': 'city', 'address-level1': 'state',
    'postal-code': 'postalCode', country: 'country', 'country-name': 'country', organization: 'company', 'organization-title': 'title', url: 'website' }[autocomplete];
  const label = words(field.label);
  const attributes = words(`${field.name} ${field.id} ${field.placeholder}`);
  if (SKIP.test(label) || (!label && SKIP.test(attributes))) return null;
  const part = partOf(field);
  if (field.kind === 'checkbox') {
    return part === 'experience' && /current|presently|still (work|employed)|work here|至今|在职/.test(`${label} ${attributes}`) ? 'workCurrent' : null;
  }
  if (part) {
    for (const text of [label, attributes]) {
      if (!text) continue;
      const rule = PART_RULES[part].find(([key, pattern]) => pattern.test(text) && !(DATE_KEYS.includes(key) && field.type === 'textarea'));
      if (rule) return rule[0];
    }
  }
  if (byAutocomplete) return byAutocomplete;
  for (const text of [label, attributes]) {
    if (!text) continue;
    const rule = RULES.find(([, pattern]) => pattern.test(text));
    if (rule) return rule[0];
  }
  return null;
}

// A LinkedIn handle, or a link typed without https, as the profile's link;
// anything else (such as the name on the profile) as written.
function linkedinLink(value) {
  const text = String(value || '').trim();
  if (/linkedin\.com\//i.test(text)) return /^https?:\/\//i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`;
  const handle = /^@?([\w-]{3,100})\/?$/.exec(text)?.[1];
  return handle ? `https://www.linkedin.com/in/${handle}` : text;
}

// The profile's answer for a key, as text; n picks the school or job.
function answerFor(key, profile, n = 0) {
  const join = (...parts) => parts.filter(Boolean).join(' ');
  const school = (profile.education || [])[n] || {};
  const job = (profile.experience || [])[n] || {};
  const latest = (profile.experience || []).find(item => item.current) || (profile.experience || [])[0] || {};
  switch (key) {
    case 'linkedin': return linkedinLink(profile.linkedin);
    case 'school': case 'degree': case 'major': case 'gpa': return school[key] ?? '';
    case 'eduStart': return school.start ?? '';
    case 'graduation': return school.end ?? '';
    case 'company': case 'title': return job[key] ?? '';
    case 'workLocation': return job.location ?? '';
    case 'workStart': return job.start ?? '';
    case 'workEnd': return job.current ? '' : job.end ?? '';
    case 'workSummary': return job.summary ?? '';
    case 'workCurrent': return job.current ? 'yes' : '';
    case 'currentCompany': return latest.company ?? '';
    case 'currentTitle': return latest.title ?? '';
    case 'fullName': return join(profile.firstName, profile.lastName);
    case 'preferredName': return profile.preferredName || profile.firstName;
    case 'location': return [profile.city, profile.state].filter(Boolean).join(', ') || profile.country;
    case 'authorizedWithoutSponsorship':
      if (profile.needsSponsorship === 'yes') return 'no';
      return profile.workAuthorized === 'yes' && profile.needsSponsorship === 'no' ? 'yes' : '';
    case 'eeoGender': case 'eeoRace': case 'eeoVeteran': case 'eeoDisability': return profile.declineEeo ? 'decline' : '';
    default: return profile[key] ?? '';
  }
}

const range = text => {
  const numbers = (String(text).match(/\d+(\.\d+)?/g) || []).map(Number);
  if (!numbers.length) return null;
  if (/less than|under|fewer|<|以下|以内/.test(text)) return [0, numbers[0] - 0.001];
  if (/\+|more|over|above|or more|以上/.test(text)) return [numbers[0], Infinity];
  return [numbers[0], numbers[1] ?? numbers[0]];
};

// Which option answers the question, or -1.
function optionFor(key, answer, options) {
  const list = options.map(option => norm(option));
  const pick = test => list.findIndex((option, index) => option && test(option, index));
  if (YES_NO_KEYS.includes(key)) {
    if (answer === 'yes') return pick(option => /^(yes|是)\b/.test(option) || option === '是');
    if (answer === 'no') return pick(option => /^(no|否)\b/.test(option) || option === '否');
    return -1;
  }
  if (key.startsWith('eeo')) return answer === 'decline' ? pick(option => DECLINE.test(option)) : -1;
  const value = norm(answer);
  if (!value) return -1;
  if (key === 'country') {
    const names = COUNTRY_NAMES.find(group => group.includes(value)) || [value];
    const exact = pick(option => names.includes(option));
    return exact >= 0 ? exact : pick(option => names.some(name => name.length > 3 && option.includes(name)));
  }
  if (key === 'state') {
    const upper = answer.trim().toUpperCase();
    const full = norm(US_STATES[upper] || answer);
    const code = Object.keys(US_STATES).find(item => norm(US_STATES[item]) === full)?.toLowerCase();
    return pick(option => option === full || option === code || option.startsWith(`${full} `) || (code && option.startsWith(`${code} `)));
  }
  if (key === 'yearsExperience') {
    const years = Number(answer);
    if (!Number.isFinite(years)) return -1;
    return pick((option, index) => { const span = range(options[index]); return span && years >= span[0] && years <= span[1]; });
  }
  if (key === 'degree') {
    const kinds = [/ph ?d|doctor|博士/, /master|mba|硕士|研究生/, /bachelor|ba\b|bs\b|undergrad|本科|学士/, /associate|专科/, /high school|高中/];
    const kind = kinds.find(pattern => pattern.test(value));
    if (kind) return pick(option => kind.test(option));
  }
  if (DATE_KEYS.includes(key)) {
    // A month on its own (from dateAnswer) picks January…December or 1…12; otherwise the year.
    if (/^\d{1,2}$/.test(answer)) {
      const month = Number(answer);
      return pick(option => option.startsWith(MONTH_NAMES[month - 1].slice(0, 3)) || option === String(month) || option === answer.padStart(2, '0') || option === `${month}月`);
    }
    const year = /\b(19|20)\d\d\b/.exec(answer)?.[0];
    return year ? pick(option => option === year) : -1;
  }
  const exact = pick(option => option === value);
  if (exact >= 0) return exact;
  return value.length >= 3 ? pick(option => option.length >= 3 && (option.includes(value) || value.includes(option))) : -1;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Which part of a date a field asks for, from its label and placeholder.
function datePart(field) {
  const hint = words(`${field.label} ${field.placeholder}`);
  const month = /\bmonth\b|^mm$|月份?$/.test(hint) || words(field.placeholder) === 'mm';
  const year = /\byear\b|^yyyy$|年份?$/.test(hint) || words(field.placeholder) === 'yyyy';
  return month && !year ? 'month' : year && !month ? 'year' : 'full';
}
// A profile date (2024-08 or 2024) as the field wants it: the month or the
// year alone, YYYY-MM for a month input, or as its placeholder shows (MM/YYYY
// when it does not say).
function dateAnswer(value, field) {
  const [year, month] = String(value).split('-');
  const part = datePart(field);
  if (part === 'year') return year;
  if (part === 'month') return month || '';
  if (field.kind !== 'text') return value;
  if (field.type === 'month') return month ? `${year}-${month}` : '';
  if (field.type !== 'text') return '';
  if (!month) return year;
  const shape = /(yyyy)([-/. ]?)(mm)|(mm)([-/. ]?)(yyyy)/i.exec(field.placeholder || '');
  if (shape?.[1]) return `${year}${shape[2]}${month}`;
  return `${month}${shape?.[5] ?? '/'}${year}`;
}

// What to put in each field: [{ frame, index, value } | { frame, index, option }
// | { frame, index, check }] plus which profile entry each filled field took,
// for the summary. The nth field of a kind for schools or jobs (counting
// filled ones, so a second pass lines up) takes the nth entry. Inside an
// Education or Work Experience part, a field that comes after the start of a
// later entry belongs to that entry.
function planFill(fields, profile) {
  const fills = [];
  const used = [];
  const seen = new Map();
  for (const field of fields) {
    if (field.kind === 'file') continue;
    const key = keyFor(field);
    if (!key) continue;
    let n = 0;
    if (ENTRY_KEYS[key]) {
      const part = partOf(field);
      const group = `${ENTRY_KEYS[key]}:${part ? 'part' : 'loose'}`;
      if (!seen.has(group)) seen.set(group, new Map());
      const counts = seen.get(group);
      const slot = DATE_KEYS.includes(key) ? `${key}:${datePart(field)}` : key;
      const count = counts.get(slot) || 0;
      n = part ? Math.max(count, Math.max(0, ...counts.values()) - 1) : count;
      counts.set(slot, count + 1);
    }
    if (field.filled) continue;
    let answer = String(answerFor(key, profile, n) || '').trim();
    if (answer && DATE_KEYS.includes(key)) answer = dateAnswer(answer, field);
    if (!answer) continue;
    if (field.kind === 'checkbox') {
      if (key !== 'workCurrent' || answer !== 'yes') continue;
      fills.push({ frame: field.frame, index: field.index, check: true });
    } else if (field.kind === 'select' || field.kind === 'radio') {
      const option = optionFor(key, answer, field.options || []);
      if (option < 0) continue;
      fills.push({ frame: field.frame, index: field.index, option });
    } else {
      // Yes / no and self-identification answers only go into choices.
      if (YES_NO_KEYS.includes(key) || key.startsWith('eeo')) continue;
      if (field.type === 'number' && !/^\d+(\.\d+)?$/.test(answer)) continue;
      if (field.type === 'month' && !/^\d{4}-\d\d$/.test(answer)) continue;
      if (['date', 'datetime-local', 'time', 'week'].includes(field.type)) continue;
      if (field.type === 'email' && key !== 'email') continue;
      if (key === 'coverLetter' && field.type !== 'textarea') continue;
      if (field.type === 'url' && !/^https?:\/\//i.test(answer)) continue;
      fills.push({ frame: field.frame, index: field.index, value: answer });
    }
    used.push({ label: field.label || field.name || field.placeholder, key });
  }
  return { fills, used };
}

// The code that runs one step in a frame.
function autofillScript(name, method, args) {
  return `(${installAutofill.toString()})(${JSON.stringify(name)}).${method}(${args === undefined ? '' : JSON.stringify(args)})`;
}

module.exports = { autofillScript, planFill, keyFor, optionFor };
