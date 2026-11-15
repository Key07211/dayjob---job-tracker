// What a search found that Dayjob already had, in words: where each of those jobs stands. outcome comes with a run
// ({ new, listed, saved, removed, applied, duplicates }); runs from before 0.36 have none. t is a (中文, English) picker.
export function knownParts(outcome, t) {
  if (!outcome) return [];
  const part = (count, zh, en) => (count ? [t(zh, en)] : []);
  return [
    ...part(outcome.listed, `${outcome.listed} 个已在今日岗位`, `${outcome.listed} already in Today`),
    ...part(outcome.saved, `${outcome.saved} 个已收藏`, `${outcome.saved} saved`),
    ...part(outcome.removed, `${outcome.removed} 个在“不感兴趣”里`, `${outcome.removed} in Not interested`),
    ...part(outcome.applied, `${outcome.applied} 个已投递`, `${outcome.applied} applied to`),
    ...part(outcome.duplicates, `${outcome.duplicates} 个与别的来源重复`, `${outcome.duplicates} listed on another site too`),
  ];
}

// The line under the record when a search ends. It is kept short (the sidebar is narrow): how many jobs, how many
// of them new. Where the others stood is said on the Today page (feedNote) and in the run's record on Searches.
export function runResult(run, t) {
  if (run.status === 'failed') return t('这次抓取没有成功，详情见“搜索与公司”。', 'This search did not succeed. See Searches for details.');
  if (!run.found) return t('这次没有抓到岗位。', 'No jobs found this time.');
  const jobs = run.found === 1 ? 'job' : 'jobs';
  if (run.newCount) return t(`抓到 ${run.found} 个岗位，${run.newCount} 个是新的。`, `Found ${run.found} ${jobs}, ${run.newCount} new.`);
  return t(`抓到 ${run.found} 个岗位，没有新的。`, `Found ${run.found} ${jobs}, none new.`);
}

// What the Today page says about the newest search when part of what it found did not come in as new: how many it
// found, how many were new, and where the rest already stood. when is the run's time in words. Nothing to say ('')
// when every job was new, when the run failed, or for a run from before 0.36.
export function feedNote(run, t, when) {
  if (!run?.outcome || run.status === 'failed' || !run.found || run.found <= run.newCount) return '';
  const known = knownParts(run.outcome, t);
  if (!known.length) return '';
  const jobs = run.found === 1 ? 'job' : 'jobs';
  return run.newCount
    ? t(`上次抓取（${when}）找到 ${run.found} 个岗位，${run.newCount} 个是新的；其余的 Dayjob 已经有了：${known.join('，')}。`,
      `The last search (${when}) found ${run.found} ${jobs}, ${run.newCount} of them new. Dayjob already had the rest: ${known.join(', ')}.`)
    : t(`上次抓取（${when}）找到 ${run.found} 个岗位，Dayjob 都已经有了：${known.join('，')}。`,
      `The last search (${when}) found ${run.found} ${jobs}, and Dayjob already had ${run.found === 1 ? 'it' : 'all of them'}: ${known.join(', ')}.`);
}
