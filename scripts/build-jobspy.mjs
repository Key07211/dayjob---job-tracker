// Puts together build/jobspy: a Python that runs JobSpy with nothing else installed, which the Windows app
// carries inside it (package.json build.extraResources -> resources/jobspy). Glassdoor, ZipRecruiter and Google
// Jobs then work straight after Dayjob is installed.
//   npm run jobspy:build
// Python is the Python Software Foundation's own package from nuget.org; the packages come from PyPI at the exact
// versions and SHA-256 hashes in scripts/jobspy-requirements.txt. Both are checked, so a build either gets exactly
// these files or stops. On Windows the packages are installed by that Python and the result is started once.
// Elsewhere the same Windows wheels are fetched with the computer's own pip, which puts the folder together but
// cannot start it.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PYTHON = { version: '3.12.10', tag: '312',
  url: 'https://api.nuget.org/v3-flatcontainer/python/3.12.10/python.3.12.10.nupkg',
  sha256: '0eb85c2dfccccf1b17352de4c397f69194035b7d37149eacc16f1147d93de3b8' };
export const JOBSPY = '1.4.1';

const root = fileURLToPath(new URL('../', import.meta.url));
const requirements = path.join(root, 'scripts', 'jobspy-requirements.txt');

// Parts of Python that running JobSpy never touches: headers and import libraries for building C code, the
// test suite, the editor, Tk, and the tools that make environments and install packages.
const PYTHON_SKIP = ['include/', 'libs/', 'Lib/test/', 'Lib/idlelib/', 'Lib/tkinter/', 'Lib/turtledemo/', 'Lib/lib2to3/', 'Lib/ensurepip/', 'Lib/venv/'];
export const wantedFromPython = name => !PYTHON_SKIP.some(prefix => name === prefix.slice(0, -1) || name.startsWith(prefix));
// In the installed packages: their own test suites, type stubs, caches, and the little programs pip writes.
export const dropped = relative => {
  const parts = relative.split('/');
  return parts.includes('__pycache__') || parts.includes('tests') || relative.endsWith('.pyi') || parts[0] === 'bin'
    || /^pip(-[\d.]+\.dist-info)?$/.test(parts[0]);
};
// python312._pth, beside python.exe: these folders are all Python looks in. With it Python also ignores every
// PYTHON* variable, the registry, the user's own packages and the folder it is started from, so another Python
// on the computer, or a file lying around, cannot get in.
export const pathFile = () => ['Lib', 'Lib\\site-packages', 'DLLs', ''].join('\r\n');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', cwd: root });
  if (result.error) throw new Error(`Cannot start ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 4).join(' ')} … ended with ${result.status}`);
  return (result.stdout || '').trim();
}

async function pythonPackage(cacheDir) {
  const file = path.join(cacheDir, path.basename(PYTHON.url));
  const digest = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!fs.existsSync(file) || digest() !== PYTHON.sha256) {
    console.log(`Downloading Python ${PYTHON.version} from nuget.org`);
    const response = await fetch(PYTHON.url);
    if (!response.ok) throw new Error(`Python ${PYTHON.version}: nuget.org answered HTTP ${response.status}`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  if (digest() !== PYTHON.sha256) {
    const got = digest();
    fs.rmSync(file, { force: true });
    throw new Error(`Python ${PYTHON.version}: the download is not the expected file (sha256 ${got}).`);
  }
  return file;
}

async function unpackPython(file, out) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  let count = 0;
  for (const entry of Object.values(zip.files)) {
    // A NuGet package writes special characters in its file names the way a web address does.
    const name = decodeURIComponent(entry.name);
    if (entry.dir || !name.startsWith('tools/')) continue;
    const relative = name.slice('tools/'.length);
    if (!wantedFromPython(relative)) continue;
    const target = path.join(out, relative);
    if (!target.startsWith(out + path.sep)) throw new Error(`Unexpected path in the Python package: ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
    count += 1;
  }
  if (!fs.existsSync(path.join(out, 'python.exe')) || !fs.existsSync(path.join(out, `python${PYTHON.tag}.dll`))) throw new Error('The Python package has no python.exe.');
  return count;
}

function prune(sitePackages) {
  let removed = 0;
  const walk = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const inner = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (dropped(inner)) { fs.rmSync(full, { recursive: true, force: true }); removed += 1; }
      else if (entry.isDirectory()) walk(full, inner);
    }
  };
  walk(sitePackages, '');
  return removed;
}

function size(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    bytes += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
    files += 1;
  }
  return { bytes, files };
}

export async function build({ out = path.join(root, 'build', 'jobspy'), cacheDir = path.join(root, 'build', 'cache') } = {}) {
  const windows = process.platform === 'win32';
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const count = await unpackPython(await pythonPackage(cacheDir), out);
  console.log(`Python ${PYTHON.version}: ${count} files`);

  const sitePackages = path.join(out, 'Lib', 'site-packages');
  const install = ['--isolated', 'install', '--disable-pip-version-check', '--no-warn-script-location', '--no-compile', '--no-deps', '--only-binary=:all:', '--require-hashes',
    '--target', sitePackages, '-r', requirements];
  // -I: this Python alone, without the build computer's own packages or PYTHON* variables.
  if (windows) run(path.join(out, 'python.exe'), ['-I', '-m', 'pip', ...install]);
  else run(process.env.PYTHON || 'python3', ['-m', 'pip', ...install, '--platform', 'win_amd64', '--python-version', PYTHON.version.split('.').slice(0, 2).join('.'), '--implementation', 'cp']);
  if (!fs.existsSync(path.join(sitePackages, 'jobspy', '__main__.py'))) throw new Error('python-jobspy was not installed.');
  if (!fs.existsSync(path.join(sitePackages, `python_jobspy-${JOBSPY}.dist-info`))) throw new Error(`scripts/jobspy-requirements.txt does not install python-jobspy ${JOBSPY}.`);
  const removed = prune(sitePackages);
  fs.writeFileSync(path.join(out, `python${PYTHON.tag}._pth`), pathFile());
  fs.writeFileSync(path.join(out, 'runtime.json'), `${JSON.stringify({ python: PYTHON.version, jobspy: JOBSPY }, null, 2)}\n`);

  if (windows) {
    // Started the way Dayjob starts it, and asked where it loads from: every folder must be inside this one.
    const python = path.join(out, 'python.exe');
    const version = run(python, ['-X', 'utf8', '-m', 'jobspy', '--version'], { capture: true });
    if (version !== JOBSPY) throw new Error(`The built JobSpy says it is "${version}", not ${JOBSPY}.`);
    const paths = run(python, ['-c', 'import sys, jobspy, pandas, numpy, curl_cffi, bs4, markdownify, pydantic, requests; print("|".join(p for p in sys.path if p))'], { capture: true }).split('|');
    const outside = paths.filter(entry => !path.resolve(entry).toLowerCase().startsWith(path.resolve(out).toLowerCase()));
    if (outside.length) throw new Error(`The built Python also looks outside its own folder: ${outside.join(', ')}`);
    // Starting it wrote caches; they would only be thrown away again by the installer.
    prune(path.join(out, 'Lib'));
  }
  const { bytes, files } = size(out);
  console.log(`JobSpy ${JOBSPY} on Python ${PYTHON.version}: ${files} files, ${(bytes / 1048576).toFixed(0)} MB in ${path.relative(root, out)} (${removed} test, stub and tool entries left out)${windows ? ', started and checked' : ', not started (this is not Windows)'}`);
  return { out, files, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().catch(error => { console.error(error.message); process.exit(1); });
}
