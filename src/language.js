// Which of Dayjob's two languages a system speaks: Chinese for any Chinese locale (zh-CN, zh-TW, zh-Hant-HK...),
// English for every other. The desktop shell follows the same rule for its tray (desktop/main.cjs).
export function languageFor(locale) {
  return String(locale || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
