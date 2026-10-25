import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';

// Interface copy only: job postings, resumes and AI analyses stay as written.
// Same shape as Daylight's i18n so the two can merge: t('中文', 'English').
const STORAGE_KEY = 'dayjob-language';
const TITLES = { zh: 'Dayjob · 求职追踪', en: 'Dayjob · Job tracker' };

function stored() {
  try { return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

let current = stored();

// For plain modules (formatting, API errors) that render inside the provider.
export function currentLanguage() { return current; }
export function translate(lang, zh, en) { return lang === 'en' ? (en ?? zh) : zh; }
export function tr(zh, en) { return translate(current, zh, en); }

const I18nContext = createContext(null);

export function I18nProvider({ children, onChange }) {
  const [lang, setLanguage] = useState(current);
  current = lang;
  useLayoutEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.title = TITLES[lang];
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* The switch still works for this session. */ }
  }, [lang]);
  const changed = useRef(onChange);
  changed.current = onChange;
  // Stable, so effects that depend on it do not rerun on a switch.
  // adopt: take the saved setting without writing it back.
  const setLang = useCallback((next, { adopt = false } = {}) => {
    const chosen = next === 'en' ? 'en' : 'zh';
    setLanguage(chosen);
    if (!adopt) changed.current?.(chosen);
  }, []);
  const value = useMemo(() => ({
    lang, setLang, locale: lang === 'en' ? 'en-US' : 'zh-CN', t: (zh, en) => translate(lang, zh, en),
  }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n requires I18nProvider');
  return context;
}

export function LanguageSwitch({ compact = false }) {
  const { lang, setLang, t } = useI18n();
  if (compact) {
    return (
      <button type="button" className="language-toggle" data-fx="flip lang" title={t('切换到 English', 'Switch to 中文')} lang={lang === 'en' ? 'zh-CN' : 'en'}
        onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}>{lang === 'en' ? '中' : 'EN'}</button>
    );
  }
  return (
    <div className="segmented" role="group" aria-label={t('界面语言', 'Language')}>
      <button type="button" lang="zh-CN" data-fx="lang" className={lang === 'zh' ? 'active' : ''} aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>中文</button>
      <button type="button" lang="en" data-fx="lang" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>English</button>
    </div>
  );
}
