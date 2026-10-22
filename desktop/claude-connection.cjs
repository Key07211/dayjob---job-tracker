const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Starts the bridge the way Claude would and calls dayjob_status through it.
async function probeDayjob({ command, args, env, timeoutMs = 12000, signal }) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  if (signal?.aborted) throw new Error('MCP probe cancelled.');
  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' });
  transport.stderr?.resume();
  const client = new Client({ name: 'dayjob-connection-check', version: '1.0.0' });
  let timer;
  let cancel;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport, { timeout: timeoutMs });
        const { tools } = await client.listTools({}, { timeout: timeoutMs });
        if (!tools.some(tool => tool.name === 'dayjob_status')) throw new Error('Dayjob status tool is unavailable.');
        const status = await client.callTool({ name: 'dayjob_status', arguments: {} }, undefined, { timeout: timeoutMs });
        if (status.isError) throw new Error('Dayjob status check failed.');
        return { toolCount: tools.length, serviceUrl: env.DAYJOB_URL };
      })(),
      new Promise((_, reject) => {
        cancel = () => reject(new Error('MCP probe cancelled.'));
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(cancel, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Dayjob MCP requires a local HTTP origin.');
  }
  return url.origin;
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (/^[a-z]:[\\/]/i.test(left) && /^[a-z]:[\\/]/i.test(right)) {
    return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  }
  return left === right;
}

function isDirectory(fsImpl, value) {
  try { return fsImpl.statSync(value).isDirectory(); } catch { return false; }
}

function isFile(fsImpl, value) {
  try { return fsImpl.statSync(value).isFile(); } catch { return false; }
}

/**
 * Claude Code keeps user-scoped MCP servers in ~/.claude.json (or
 * $CLAUDE_CONFIG_DIR/.claude.json). Claude Desktop reads
 * claude_desktop_config.json from its roaming profile; the Microsoft Store
 * build virtualizes that profile under its package LocalCache.
 */
function claudeTargets(env = process.env, { fsImpl = fs, platform = process.platform, homedir = os.homedir() } = {}) {
  const home = env.USERPROFILE || env.HOME || homedir;
  const codeDirectory = env.CLAUDE_CONFIG_DIR || home;
  const codeConfig = path.join(codeDirectory, '.claude.json');
  const targets = [{ id: 'code', label: 'Claude Code', configPath: codeConfig, entryType: 'stdio',
    installed: isFile(fsImpl, codeConfig) || isDirectory(fsImpl, path.join(home, '.claude')) || Boolean(env.CLAUDE_CONFIG_DIR && isDirectory(fsImpl, env.CLAUDE_CONFIG_DIR)) }];
  let desktopDirectory = null;
  if (platform === 'win32' || env.APPDATA) {
    if (env.LOCALAPPDATA) {
      try {
        const packages = path.join(env.LOCALAPPDATA, 'Packages');
        const packaged = fsImpl.readdirSync(packages, { withFileTypes: true })
          .filter(item => item.isDirectory() && /^Claude_/i.test(item.name))
          .map(item => path.join(packages, item.name, 'LocalCache', 'Roaming', 'Claude'))
          .find(directory => isDirectory(fsImpl, directory));
        if (packaged) desktopDirectory = packaged;
      } catch { /* The Store build is optional. */ }
    }
    if (!desktopDirectory && env.APPDATA) desktopDirectory = path.join(env.APPDATA, 'Claude');
  } else if (platform === 'darwin') {
    desktopDirectory = path.join(home, 'Library', 'Application Support', 'Claude');
  } else {
    desktopDirectory = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
  }
  if (desktopDirectory) {
    targets.push({ id: 'desktop', label: 'Claude Desktop', configPath: path.join(desktopDirectory, 'claude_desktop_config.json'),
      installed: isDirectory(fsImpl, desktopDirectory) });
  }
  return targets;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Registers the Dayjob stdio bridge with Claude Code and Claude Desktop.
 * check() never writes. ensure() adds a missing entry, or repoints an entry
 * that is recognizably an older Dayjob bridge; any other entry with the same
 * name is reported as a conflict and left untouched. Unrelated settings in
 * either configuration file are preserved.
 */
function createClaudeConnection({ command, args = [], env = {}, serverName = 'dayjob', targets = () => claudeTargets(),
  probe = probeDayjob, fsImpl = fs, timeoutMs = 12000, now = () => new Date() } = {}) {
  if (!command || typeof command !== 'string' || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')
      || !/^[a-zA-Z0-9_-]+$/.test(serverName) || !env || Object.values(env).some(value => typeof value !== 'string')) {
    throw new Error('Invalid Dayjob Claude connection configuration.');
  }
  const desired = { command, args: [...args], env: { ...env } };
  const serviceUrl = localOrigin(desired.env.DAYJOB_URL);
  let last = { state: 'missing', registered: false, toolCount: 0, serviceUrl, checkedAt: null, clients: [], message: 'Connection has not been checked.' };
  let flight = null;
  let ensureRequested = false;

  const snapshot = () => ({ ...last, clients: last.clients.map(client => ({ ...client })) });
  function publish(state, clients, message, toolCount = 0) {
    const date = new Date(now());
    last = { state, registered: clients.some(client => client.registered), toolCount, serviceUrl, clients,
      checkedAt: (Number.isFinite(date.getTime()) ? date : new Date()).toISOString(), ...(message ? { message } : {}) };
    return snapshot();
  }

  function readConfig(target) {
    let text = null;
    try { text = fsImpl.readFileSync(target.configPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') return { failure: true }; }
    if (text === null || !text.trim()) return { config: {}, text };
    try {
      const config = JSON.parse(text.replace(/^﻿/, ''));
      if (!plainObject(config) || (config.mcpServers !== undefined && !plainObject(config.mcpServers))) return { failure: true };
      return { config, text };
    } catch { return { failure: true }; }
  }
  function matches(entry) {
    return plainObject(entry) && (entry.type === undefined || entry.type === 'stdio')
      && samePath(entry.command, desired.command) && Array.isArray(entry.args)
      && entry.args.length === desired.args.length && entry.args.every((arg, index) => samePath(arg, desired.args[index]))
      && Object.entries(desired.env).every(([key, value]) => entry.env?.[key] === value);
  }
  // An entry we wrote earlier from another install directory or source checkout.
  function formerDayjob(entry) {
    if (!plainObject(entry) || (entry.type !== undefined && entry.type !== 'stdio') || typeof entry.command !== 'string'
        || !Array.isArray(entry.args) || entry.args.length !== 1 || typeof entry.args[0] !== 'string'
        || !/[\\/]integrations[\\/]mcp-server\.mjs$/i.test(entry.args[0]) || !plainObject(entry.env)) return false;
    try { return localOrigin(entry.env.DAYJOB_URL) === serviceUrl; } catch { return false; }
  }
  function entryFor(target, previous) {
    const merged = { ...(plainObject(previous?.env) ? previous.env : {}), ...desired.env };
    return { ...(target.entryType ? { type: target.entryType } : {}), command: desired.command, args: [...desired.args], env: merged };
  }
  function write(target, original, config) {
    const directory = path.dirname(target.configPath);
    const temporary = `${target.configPath}.${process.pid}.${Date.now()}.dayjob-tmp`;
    fsImpl.mkdirSync(directory, { recursive: true });
    try {
      // Claude rewrites its own files; refuse to overwrite a concurrent change.
      let current = null;
      try { current = fsImpl.readFileSync(target.configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== original) throw new Error('Configuration changed while connecting.');
      if (original) fsImpl.writeFileSync(`${target.configPath}.dayjob-backup`, original, { mode: 0o600 });
      fsImpl.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      fsImpl.renameSync(temporary, target.configPath);
    } finally { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); }
  }
  function inspect(target, ensure) {
    const client = { id: target.id, label: target.label, configPath: target.configPath, registered: false };
    if (!target.installed) return { ...client, state: 'unavailable' };
    const read = readConfig(target);
    if (read.failure) return { ...client, state: 'error', message: 'unreadable' };
    const entry = read.config.mcpServers?.[serverName];
    if (entry !== undefined && matches(entry)) return { ...client, state: 'configured', registered: true };
    if (entry !== undefined && !formerDayjob(entry)) return { ...client, state: 'conflict', registered: true };
    if (!ensure) return { ...client, state: entry === undefined ? 'missing' : 'conflict', registered: entry !== undefined };
    const config = { ...read.config, mcpServers: { ...(read.config.mcpServers || {}), [serverName]: entryFor(target, entry) } };
    try { write(target, read.text, config); }
    catch { return { ...client, state: 'error', message: 'write-failed' }; }
    const verified = readConfig(target);
    if (verified.failure || !matches(verified.config.mcpServers?.[serverName])) return { ...client, state: 'error', message: 'not-retained' };
    return { ...client, state: 'configured', registered: true, changed: true };
  }
  async function health() {
    const controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        probe({ ...desired, registration: { transport: {} }, timeoutMs, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Probe timed out.')); }, timeoutMs + 5000); }),
      ]);
      if (!Number.isInteger(result.toolCount) || result.toolCount < 1 || localOrigin(result.serviceUrl) !== serviceUrl) throw new Error('Invalid probe response.');
      return result.toolCount;
    } catch { return 0; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function run(ensure) {
    let list;
    try { list = targets(); } catch { list = []; }
    const clients = list.map(target => inspect(target, ensure));
    if (!clients.some(client => client.state !== 'unavailable')) {
      return publish('unavailable', clients, 'Neither Claude Code nor Claude Desktop was found.');
    }
    const configured = clients.filter(client => client.state === 'configured');
    if (configured.length) {
      const toolCount = await health();
      if (!toolCount) {
        for (const client of configured) client.state = 'error';
        return publish('error', clients, 'Registered in Claude, but the Dayjob MCP health check failed. Keep Dayjob running and retry.');
      }
      for (const client of configured) client.state = 'ready';
      return publish('ready', clients, undefined, toolCount);
    }
    if (clients.some(client => client.state === 'conflict')) {
      return publish('conflict', clients, 'A different Dayjob connection already exists in Claude. It was not changed.');
    }
    if (clients.some(client => client.state === 'error')) {
      return publish('error', clients, 'Unable to update the Claude configuration. Existing settings were not changed.');
    }
    return publish('missing', clients, 'Dayjob has not been registered in Claude.');
  }
  function start(ensure) {
    if (ensure) ensureRequested = true;
    if (flight) return flight.then(result => ensure && result.state === 'missing' ? start(true) : result);
    flight = Promise.resolve().then(() => run(ensureRequested))
      .catch(() => publish('error', [], 'Unable to check the Claude connection.'))
      .finally(() => { flight = null; ensureRequested = false; });
    return flight;
  }
  return { check: () => start(false), ensure: () => start(true), getStatus: snapshot };
}

module.exports = { createClaudeConnection, claudeTargets, probeDayjob };
