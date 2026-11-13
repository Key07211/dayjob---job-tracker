import { useEffect, useRef, useState } from 'react';
import { CircleDollarSign, TriangleAlert, X } from 'lucide-react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { formatDay, usd } from './format.js';
import { Select } from './groove/Picker.jsx';
import { shake } from './groove/fx.js';

// What the API keys have cost and how much each has left, by Dayjob's own count: every call's tokens at the list
// prices of the day it was made. The services show no balance to an ordinary key, so the allowance is the amount
// the user types in (the key's balance right now, or a budget for each month) and Dayjob counts down from it.
const SERVICES = { anthropic: 'Claude API', openai: 'OpenAI API' };

// One bar a day for the last 30 days, the newest on the right. Pointing at a day puts what it cost in the corner
// where the highest day is named.
function Days({ daily }) {
  const { t } = useI18n();
  const [at, setAt] = useState(null);
  const max = Math.max(...daily.map(day => day.usd));
  const top = daily.reduce((best, day) => (day.usd > best.usd ? day : best), daily[0]);
  const shown = at === null ? null : daily[at];
  return (
    <div className="spend-days">
      <div className="spend-days-head"><span>{t('每天', 'By day')}</span>
        {shown ? <span className="on">{formatDay(shown.date)} · <b>{usd(shown.usd)}</b></span> : <span>{t(`最高 ${usd(max)}（${formatDay(top.date)}）`, `Peak ${usd(max)} (${formatDay(top.date)})`)}</span>}</div>
      <div className="spend-plot" role="img" onMouseLeave={() => setAt(null)}
        aria-label={t(`近 30 天每天的 API 花费，最高的一天是 ${formatDay(top.date)}，${usd(max)}。`, `API spending for each of the last 30 days. The highest day was ${formatDay(top.date)} at ${usd(max)}.`)}>
        {daily.map((day, index) => (
          <span key={day.date} className={`spend-day${index === daily.length - 1 ? ' today' : ''}${index === at ? ' on' : ''}`} onMouseEnter={() => setAt(index)}>
            {day.usd > 0 ? <i style={{ height: `max(3px, ${day.usd / max * 100}%)` }} /> : null}
          </span>
        ))}
      </div>
      <div className="spend-days-foot"><span>{formatDay(daily[0].date)}</span><span>{t('今天', 'Today')}</span></div>
    </div>
  );
}

function KeyRow({ item, hint, lowPercent, onDone }) {
  const { t } = useI18n();
  const form = useRef(null);
  const allowance = item.allowance;
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState('balance');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function edit() {
    setKind(allowance?.kind || 'balance');
    // A balance is typed in fresh each time (it is what the console shows now); a monthly budget usually stays.
    setAmount(allowance?.kind === 'monthly' ? String(allowance.amount) : '');
    setError('');
    setEditing(true);
  }
  async function send(body) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/keys/${item.id}`, { method: 'PATCH', body });
      await onDone();
      setEditing(false);
    } catch (failure) {
      setError(failure.message);
      shake(form.current);
    } finally { setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    const value = Number(amount.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(value) || value <= 0) { setError(t('请填一个大于 0 的美元金额。', 'Enter an amount in US dollars, more than 0.')); shake(form.current); return; }
    void send({ allowance: { kind, amount: value } });
  }
  const state = !allowance ? '' : allowance.left <= 0 ? 'empty' : allowance.percent <= lowPercent ? 'low' : '';
  return (
    <li className="spend-key">
      <div className="spend-key-name">
        <div><strong>{item.name || hint || SERVICES[item.service]}</strong>{item.active ? <em>{t('使用中', 'In use')}</em> : null}</div>
        <span>{SERVICES[item.service]}{item.name && hint ? ` · ${hint}` : ''}</span>
      </div>
      <div className="spend-key-month"><span>{t('本月', 'This month')}</span><b>{usd(item.monthUsd)}</b></div>
      {editing ? (
        <form className="spend-edit" ref={form} onSubmit={save}>
          <Select value={kind} onChange={event => setKind(event.target.value)} aria-label={t('额度的算法', 'How the allowance counts')}>
            <option value="balance">{t('充值余额', 'Prepaid balance')}</option>
            <option value="monthly">{t('每月预算', 'Monthly budget')}</option>
          </Select>
          <label className="spend-amount"><span>$</span>
            <input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" maxLength={12} autoFocus placeholder={kind === 'monthly' ? '20.00' : t('现在的余额', 'Balance now')}
              aria-label={kind === 'monthly' ? t('每月预算（美元）', 'Monthly budget in US dollars') : t('现在的余额（美元）', 'Balance now in US dollars')} /></label>
          <button type="submit" className="button small primary" disabled={busy || !amount.trim()}>{t('保存', 'Save')}</button>
          {allowance ? <button type="button" className="button small" disabled={busy} onClick={() => send({ allowance: null })}>{t('不再计算', 'Stop counting')}</button> : null}
          <button type="button" className="icon-button" title={t('取消', 'Cancel')} onClick={() => setEditing(false)}><X size={14} /></button>
          <p className="hint">{kind === 'monthly'
            ? t('这把 key 每个月打算最多花多少。每月 1 日重新算起，本月已经花的也算在内。', 'The most this key should spend in a month. It starts again on the 1st, and what this month has already cost counts.')
            : t('填服务商控制台里这把 key 现在的余额。Dayjob 从这一刻起往下减；充值之后回来再填一次。', 'Enter the balance the service\'s console shows for this key right now. Dayjob counts down from this moment; enter it again after you top up.')}</p>
          {error ? <p className="notice error">{error}</p> : null}
        </form>
      ) : allowance ? (
        <div className={`spend-left${state ? ` ${state}` : ''}`}>
          <div className="spend-left-line">
            <b>{t(`剩 ${allowance.percent}%`, `${allowance.percent}% left`)}</b>
            <span>{t(`${usd(allowance.left)} / ${usd(allowance.amount)}`, `${usd(allowance.left)} of ${usd(allowance.amount)}`)}</span>
            {state ? <em><TriangleAlert size={13} />{state === 'empty' ? t('用完了', 'Used up') : t('不多了', 'Running low')}</em> : null}
          </div>
          <div className="spend-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={allowance.percent} aria-label={t('剩余额度', 'Allowance left')}><i style={{ width: `${allowance.percent}%` }} /></div>
          <small>{allowance.kind === 'monthly' ? t(`每月预算，${formatDay(allowance.since)}起算`, `Monthly budget, counted from ${formatDay(allowance.since)}`)
            : t(`余额是 ${formatDay(allowance.at)}填的，之后用了 ${usd(allowance.used)}`, `Balance entered ${formatDay(allowance.at)}; ${usd(allowance.used)} used since`)}</small>
        </div>
      ) : <div className="spend-left none">{t('还没有设额度', 'No allowance set')}</div>}
      {editing ? null : <button type="button" className="button small" onClick={edit}>{allowance ? t('更新额度', 'Update') : t('设置额度', 'Set allowance')}</button>}
    </li>
  );
}

export function Spend({ boot, reload, focused }) {
  const { t } = useI18n();
  const card = useRef(null);
  const [spend, setSpend] = useState(null);
  const keys = boot.settings.apiKeys || [];
  const stamp = keys.map(entry => `${entry.id}:${entry.name}:${entry.active}:${entry.allowance?.at || ''}`).join('|');
  const load = useRef(null);
  load.current = () => api('/api/usage/spend').then(setSpend).catch(() => {});
  // Read when the page opens, when the keys change, and when the window is looked at again.
  useEffect(() => { void load.current(); }, [stamp]);
  useEffect(() => {
    const look = () => { if (document.visibilityState === 'visible') void load.current(); };
    window.addEventListener('focus', look);
    return () => window.removeEventListener('focus', look);
  }, []);
  // A link that leads here (a notification, the usage lines under Resume & AI) lands on the card once more when its
  // sums have arrived: until then the card is short, and the page may not have been long enough to bring it up.
  const loaded = Boolean(spend);
  useEffect(() => { if (focused && loaded) card.current?.scrollIntoView({ block: 'start' }); }, [focused, loaded]);
  const hints = new Map(keys.map(entry => [entry.id, entry.hint]));
  const calls = count => t(`${count} 次调用`, `${count} ${count === 1 ? 'call' : 'calls'}`);
  const head = (
    <>
      <h2><CircleDollarSign size={18} />{t('API 消费', 'API spending')}</h2>
      <p className="hint">{t('Dayjob 把每次打分和助手回答用掉的 token，按服务商的公开标价折成美元记下来。在每把 key 上填一个额度，就能看到还剩百分之几；剩得不多时会发通知。',
        'Dayjob turns the tokens of every score and every assistant reply into US dollars at the services\' list prices. Give a key an allowance to see what share of it is left; a notification says when it runs low.')}</p>
    </>
  );
  // The card is on the page from the start, so a link to it has somewhere to land before the sums arrive.
  if (!spend) return <section className="card-section" id="api-spend" ref={card}>{head}</section>;
  const quiet = !spend.last30.calls;
  return (
    <section className="card-section" id="api-spend" ref={card}>
      {head}
      {quiet && !spend.keys.length ? <p className="hint">{t('还没有用 API key 调用过。', 'No calls have been made with an API key yet.')}</p> : (
        <dl className="spend-stats">
          {[[t('今天', 'Today'), spend.today], [t('本月', 'This month'), spend.month], [t('近 30 天', 'Last 30 days'), spend.last30]].map(([label, item]) => (
            <div key={label}><dt>{label}</dt><dd>{usd(item.usd)}</dd><small>{calls(item.calls)}</small></div>
          ))}
        </dl>
      )}
      {quiet ? null : <Days daily={spend.daily} />}
      {spend.keys.length ? (
        <ul className="spend-keys">
          {spend.keys.map(item => <KeyRow key={item.id} item={item} hint={hints.get(item.id)} lowPercent={spend.lowPercent} onDone={async () => { await reload(); await load.current(); }} />)}
          {spend.otherUsd > 0 ? (
            <li className="spend-key other">
              <div className="spend-key-name"><strong>{t('其他', 'Other')}</strong><span>{t('环境变量里的 key，或已经删掉的 key', 'A key from the environment, or keys since deleted')}</span></div>
              <div className="spend-key-month"><span>{t('本月', 'This month')}</span><b>{usd(spend.otherUsd)}</b></div>
            </li>
          ) : null}
        </ul>
      ) : null}
      {spend.plan.calls ? <p className="hint">{t(`本机 Claude Code 和 Codex 走订阅，本月 ${spend.plan.calls} 次调用不花 API 的钱`, `Claude Code and Codex on this computer run on a subscription: this month's ${calls(spend.plan.calls)} cost no API money`)}
        {spend.plan.usd > 0 ? t(`；同样的用量按 API 价大约是 ${usd(spend.plan.usd)}。`, `. The same usage at API prices would be about ${usd(spend.plan.usd)}.`) : t('。', '.')}</p> : null}
      {spend.last30.unpriced ? <p className="hint">{t(`近 30 天有 ${spend.last30.unpriced} 次调用的模型不在价格表里，没有算进去。`,
        `${spend.last30.unpriced} ${spend.last30.unpriced === 1 ? 'call' : 'calls'} in the last 30 days used a model that is not in the price list and ${spend.last30.unpriced === 1 ? 'is' : 'are'} not counted.`)}</p> : null}
      <p className="hint">{t(`价格是 ${spend.pricesAsOf} 读到的 Anthropic 和 OpenAI 标准价。服务商不让普通 key 查余额，所以这是 Dayjob 自己记的数：只算 Dayjob 里的调用，同一把 key 在别处的用量、批量折扣和税不在内，实际以服务商的账单为准。`,
        `Prices are Anthropic's and OpenAI's standard list prices as read on ${spend.pricesAsOf}. The services show no balance to an ordinary key, so this is Dayjob's own count: only calls made in Dayjob, without the same key's use elsewhere, volume discounts or tax. The service's bill is what counts.`)}</p>
    </section>
  );
}
