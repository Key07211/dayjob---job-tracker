import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pick, createNowPlaying } = require('../desktop/now-playing.cjs');

test('only music apps count as music; browsers never do, other apps only with an artist', () => {
  assert.deepEqual(pick([]), { track: null, browser: false });
  assert.deepEqual(pick([{ app: 'MSEdge', title: 'A video', artist: 'Some channel', playing: true }]), { track: null, browser: true });
  assert.deepEqual(pick([{ app: '308046B0AF4A39CB', title: 'Firefox tab', artist: '', playing: true }]), { track: null, browser: true });
  assert.deepEqual(pick([{ app: 'QQMusic.exe', title: '晴天', artist: '周杰伦', playing: true }]).track, { title: '晴天', artist: '周杰伦', app: 'qqmusic' });
  assert.deepEqual(pick([{ app: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', title: 'Clair de Lune', artist: '', playing: true }]).track, { title: 'Clair de Lune', artist: '', app: 'spotify' });
  assert.equal(pick([{ app: 'SomePlayer.exe', title: 'Notification', artist: '', playing: true }]).track, null, 'an unknown app without an artist is not music');
  assert.equal(pick([{ app: 'SomePlayer.exe', title: 'Song', artist: 'Band', playing: true }]).track.app, 'other');
  assert.equal(pick([{ app: 'cloudmusic.exe', title: 'Paused song', artist: 'X', playing: false }]).track, null, 'a paused song is not followed');
  const both = pick([{ app: 'chrome', title: 'Video', artist: '', playing: true }, { app: 'cloudmusic.exe', title: '稻香', artist: '周杰伦', playing: true }]);
  assert.equal(both.track.title, '稻香');
  assert.equal(both.browser, true, 'a browser playing too is reported, so the wave can stay off');
});

test('following music does nothing outside Windows', () => {
  const changes = [];
  const music = createNowPlaying({ onChange: state => changes.push(state), platform: 'linux' });
  assert.deepEqual(music.setFollow(true), { track: null, browser: false });
  assert.equal(music.following, true);
  music.setFollow(false);
  assert.equal(music.following, false);
  assert.deepEqual(changes, []);
});
