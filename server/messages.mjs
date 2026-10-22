// Notification and timeline text, in the interface language the user picked
// (settings.language). API errors and MCP replies stay in English; the
// interface translates the ones it shows.
const TEXT = {
  zh: {
    postingClosed: ({ company, title }) => ({ title: `${company || ''} 岗位已关闭`.trim(), body: `${title}：招聘页面已下线，申请仍在追踪中。` }),
    followUp: ({ company, title, days }) => ({ title: `该跟进了：${company}`, body: `${title} 已经 ${days} 天没有进展。` }),
    ghost: ({ company, title, days }) => ({ title: `可能没有回音：${company}`, body: `${title} 投递 ${days} 天无回复，可在 Dayjob 中标记为无回音或继续等待。` }),
    daily: ({ newCount, strong, names }) => ({ title: `Dayjob：${newCount} 个新岗位${strong ? `，${strong} 个高匹配` : ''}`,
      body: names.length ? names.join('；') : '打开 Dayjob 查看今天的新岗位。' }),
    scored: ({ scored, reason }) => ({ title: `AI 打分完成：${scored} 个岗位`, body: reason ? `部分未完成：${reason}` : '打开 Dayjob 查看匹配度。' }),
    scoringFailed: ({ reason }) => ({ title: 'AI 打分没有完成', body: reason }),
    noteClosed: () => '岗位已停止接受申请。',
    noteReopened: () => '岗位重新开放申请。',
    noteFollowUp: () => '跟进提醒。',
    noteGhost: ({ days }) => `${days} 天没有回复。`,
  },
  en: {
    postingClosed: ({ company, title }) => ({ title: `${company ? `${company}: ` : ''}posting closed`, body: `${title} is no longer listed. Dayjob keeps tracking your application.` }),
    followUp: ({ company, title, days }) => ({ title: `Time to follow up: ${company}`, body: `${title} has had no update for ${days} days.` }),
    ghost: ({ company, title, days }) => ({ title: `No reply yet: ${company}`, body: `${title}: no response ${days} days after applying. Mark it as ghosted in Dayjob, or keep waiting.` }),
    daily: ({ newCount, strong, names }) => ({ title: `Dayjob: ${newCount} new ${newCount === 1 ? 'job' : 'jobs'}${strong ? `, ${strong} strong ${strong === 1 ? 'match' : 'matches'}` : ''}`,
      body: names.length ? names.join('; ') : 'Open Dayjob to see today\'s new jobs.' }),
    scored: ({ scored, reason }) => ({ title: `AI scored ${scored} ${scored === 1 ? 'job' : 'jobs'}`, body: reason ? `Some were not scored: ${reason}` : 'Open Dayjob to see how they match.' }),
    scoringFailed: ({ reason }) => ({ title: 'AI scoring did not finish', body: reason }),
    noteClosed: () => 'The posting is no longer accepting applications.',
    noteReopened: () => 'The posting is accepting applications again.',
    noteFollowUp: () => 'Follow-up reminder.',
    noteGhost: ({ days }) => `No response for ${days} days.`,
  },
};

export const LANGUAGES = ['zh', 'en'];

export function message(language, key, params = {}) {
  return (TEXT[language] || TEXT.zh)[key](params);
}
