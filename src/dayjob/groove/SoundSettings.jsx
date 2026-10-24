import { useI18n } from '../../i18n.jsx';
import { KEY_WINDOWS, prefs, usePrefs, useTheme } from './prefs.js';
import { playHello, previewTune } from './sound.js';
import { appName, canFollow, setFollow, useNowPlaying } from './music.js';

const TUNES = [['auto', '跟随主题', 'With the theme'], ['morning', '晨景', 'Morning Mood'], ['moon', '月光', 'Moonlight'], ['elise', '致爱丽丝', 'Für Elise']];

function Toggle({ on, label, onChange }) {
  return <button type="button" className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}><i /></button>;
}

// Sound and music, kept on this computer: cue sounds, the sidebar's tune and how often its keys sound, and
// following a music app.
export function SoundSettings() {
  const { t } = useI18n();
  const groove = usePrefs();
  const theme = useTheme();
  const { track } = useNowPlaying();
  const playing = groove.followMusic && track;
  return (
    <section className="card-section">
      <h2>{t('声音与音乐', 'Sound and music')}</h2>
      <div className="option-row">
        <span>{t('提示音', 'Sounds')}</span>
        <Toggle on={groove.sound} label={t('提示音', 'Sounds')} onChange={on => { prefs.set({ sound: on }); if (on) playHello(); }} />
        <small>{t('落分、投递、开始抓取和按侧栏时弹一个音，一次只响一个。', 'A note when a score lands, you apply, a search starts or you press a sidebar key, one at a time.')}</small>
      </div>
      <div className="option-row">
        <span>{t('侧栏的曲子', 'Sidebar tune')}</span>
        <div className="segmented">
          {TUNES.map(([value, zh, en]) => (
            <button key={value} type="button" className={groove.tune === value ? 'active' : ''} onClick={() => { prefs.set({ tune: value }); previewTune(value, theme); }}>{t(zh, en)}</button>
          ))}
        </div>
        <small>{t('跟随主题时，白天是格里格《晨景》，黑夜是贝多芬《月光》。点一下可以试听。', 'With the theme, days play Grieg\'s Morning Mood and nights Beethoven\'s Moonlight. Pick one to hear it.')}</small>
      </div>
      <div className="option-row">
        <span>{t('按键间隔', 'Key gap')}</span>
        <div className="segmented">
          {KEY_WINDOWS.map(ms => (
            <button key={ms} type="button" className={groove.keyWindow === ms ? 'active' : ''} onClick={() => prefs.set({ keyWindow: ms })}>{`${ms / 1000} s`}</button>
          ))}
        </div>
        <small>{t('连点侧栏时，这段时间里只有第一下出声，页面照常切换。', 'Clicking sidebar keys quickly, only the first in this time sounds; the pages still switch.')}</small>
      </div>
      {canFollow ? (
        <div className="option-row">
          <span>{t('跟随音乐', 'Follow music')}</span>
          <Toggle on={groove.followMusic} label={t('跟随正在播放的音乐', 'Follow the music playing')} onChange={on => { prefs.set({ followMusic: on }); setFollow(on, { gesture: true }); }} />
          <small>{playing ? t(`正在播放：${track.title}${track.artist ? ` · ${track.artist}` : ''}${appName(track.app, t) ? `（${appName(track.app, t)}）` : ''}`,
            `Playing: ${track.title}${track.artist ? ` · ${track.artist}` : ''}${appName(track.app, t) ? ` (${appName(track.app, t)})` : ''}`)
            : t('音乐软件放歌时，唱片机显示歌名并跟着转，页面底部出现声波，提示音也会放轻。网页里的声音不算。声音只在本机分析，不录音。',
              'While a music app plays, the record player shows the song and turns with it, a wave runs along the bottom and cues play softer. Sound from web pages does not count. The sound is analysed on this computer only and never recorded.')}</small>
        </div>
      ) : null}
    </section>
  );
}
