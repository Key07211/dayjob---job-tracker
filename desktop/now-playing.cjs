const { spawn } = require('node:child_process');

// What a music app is playing, from the Windows media controls (the same list the volume flyout shows). Only
// apps made for music count; browsers never do, so a video in a web page does not move Dayjob. Other apps count
// only when they report an artist. Nothing is recorded: the poller runs only while "follow music" is on.
const BROWSERS = ['msedge', 'chrome', 'firefox', '308046b0af4a39cb', 'brave', 'opera', 'vivaldi', 'arc', 'dayjob', 'electron'];
const MUSIC_APPS = ['qqmusic', 'cloudmusic', 'kugou', 'kuwo', 'spotify', 'applemusic', 'itunes', 'foobar2000', 'musicbee', 'aimp', 'zunemusic'];
const INTERVAL = 2;

// PowerShell reads the sessions every two seconds and prints one JSON line each time. It also stops on its own
// when Dayjob is gone, so it can never outlive the app.
const script = once => `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Say($value) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 4)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
  function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); if (-not $task.Wait(5000)) { throw 'timed out' }; $task.Result }
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch { Say @{ error = $_.Exception.Message }; exit 0 }
while ($true) {
  $list = @()
  foreach ($s in $manager.GetSessions()) {
    try {
      $playing = $s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'
      $props = Await ($s.TryGetMediaPropertiesAsync()) $propsType
      $list += @{ app = [string]$s.SourceAppUserModelId; title = [string]$props.Title; artist = [string]$props.Artist; playing = $playing }
    } catch {}
  }
  Say @{ sessions = @($list) }
  if (${once ? '$true' : '$false'}) { exit 0 }
  if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { exit 0 }
  Start-Sleep -Seconds ${INTERVAL}
}
`;

const encoded = once => Buffer.from(script(once), 'utf16le').toString('base64');
const launch = once => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(once)],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

const key = app => String(app || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const known = (app, names) => names.find(name => key(app).includes(name)) || null;

// The song worth following: the first music app that is playing. A browser that is playing too is reported, so the
// listening wave can stay off rather than pick up the web page's sound.
function pick(sessions) {
  const playing = (Array.isArray(sessions) ? sessions : []).filter(item => item && item.playing);
  const browser = playing.some(item => known(item.app, BROWSERS));
  const song = playing.find(item => !known(item.app, BROWSERS) && (known(item.app, MUSIC_APPS) || String(item.artist || '').trim()));
  if (!song || !String(song.title || '').trim()) return { track: null, browser };
  return { track: { title: String(song.title).trim().slice(0, 200), artist: String(song.artist || '').trim().slice(0, 200), app: known(song.app, MUSIC_APPS) || 'other' }, browser };
}

function createNowPlaying({ onChange, platform = process.platform }) {
  let child = null;
  let current = { track: null, browser: false };
  let following = false;
  const publish = next => {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    onChange(current);
  };
  function start() {
    if (child || platform !== 'win32') return;
    let buffer = '';
    child = launch(false);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.sessions) publish(pick(value.sessions));
        } catch { /* a partial line; the next read completes it */ }
      }
    });
    const ended = () => { child = null; publish({ track: null, browser: false }); };
    child.on('exit', ended);
    child.on('error', ended);
  }
  function stop() {
    if (child) child.kill();
    child = null;
    publish({ track: null, browser: false });
  }
  return {
    get following() { return following; },
    current: () => current,
    setFollow(value) {
      following = value === true;
      if (following) start(); else stop();
      return current;
    },
    stop,
  };
}

// One read of the media sessions, for the desktop smoke test: it proves the script runs on this Windows.
function probe(timeout = 20000) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') { resolve({ ok: true, skipped: true }); return; }
    const child = launch(true);
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'timed out' }); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(out.trim().split(/\r?\n/).pop());
        // Media controls missing on this Windows (a server build) still means the script ran.
        resolve(Array.isArray(value.sessions) ? { ok: true, sessions: value.sessions.length } : { ok: typeof value.error === 'string', unavailable: value.error });
      } catch { resolve({ ok: false, error: out.slice(0, 300) || 'no output' }); }
    });
  });
}

module.exports = { createNowPlaying, probe, pick };
