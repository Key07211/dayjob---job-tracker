import { useI18n } from '../../i18n.jsx';
import { KEY_WINDOWS, WAVE_STYLES, prefs, usePrefs, useTheme } from './prefs.js';
import { playHello, previewTune } from './sound.js';
import { appName, canFollow, setFollow, useNowPlaying } from './music.js';

const TUNES = [['auto', '跟随主题', 'With the theme'], ['dew', '晨露', 'Dew'], ['canon', '卡农', 'Canon']];
const WAVE_NAMES = { beam: ['光柱', 'Light bars'], dots: ['点阵', 'Dots'], flow: ['流光', 'Soft line'] };

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
        <span>{t('琴键音效', 'Key sounds')}</span>
        <div className="segmented">
          {TUNES.map(([value, zh, en]) => (
            <button key={value} type="button" className={groove.tune === value ? 'active' : ''} onClick={() => { prefs.set({ tune: value }); previewTune(value, theme); }}>{t(zh, en)}</button>
          ))}
        </div>
        <small>{t('每个琴键有自己固定的一小段乐句，都在中低音区，越高的音越轻。晨露是清脆的玻璃钢琴，卡农是用毛毡钢琴弹的帕赫贝尔《卡农》八个和弦，从上到下按一遍就是卡农的旋律。跟随主题时白天用晨露，黑夜用卡农。点一下可以试听。',
          'Each key has its own short phrase, in the low and middle range, with higher notes played quieter. Dew is a crisp glass piano; Canon is the eight chords of Pachelbel\'s Canon on a felt piano, whose top notes, key after key, are its melody. With the theme, days play Dew and nights Canon. Pick one to hear it.')}</small>
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
            : t('音乐软件放歌时，唱片机显示歌名并跟着转，每页顶部的声浪跟着音乐起伏，提示音也会放轻。网页里的声音不算。声音只在本机分析，不录音。',
              'While a music app plays, the record player shows the song and turns with it, the wave across the top of each page moves with the music and cues play softer. Sound from web pages does not count. The sound is analysed on this computer only and never recorded.')}</small>
        </div>
      ) : null}
      {canFollow && groove.followMusic ? (
        <div className="option-row">
          <span>{t('声浪样式', 'Wave style')}</span>
          <div className="segmented">
            {WAVE_STYLES.map(value => (
              <button key={value} type="button" className={groove.waveStyle === value ? 'active' : ''} onClick={() => prefs.set({ waveStyle: value })}>{t(...WAVE_NAMES[value])}</button>
            ))}
          </div>
          <small>{t('光柱从低音到高音排开、带回落的顶点和倒影；点阵像老式音响的电平灯；流光是一条从中间向两边起伏的柔光线。',
            'Light bars run from bass to treble, with falling caps and a reflection; dots light up like an old hi-fi meter; the soft line rises and falls out from the middle.')}</small>
        </div>
      ) : null}
    </section>
  );
}
