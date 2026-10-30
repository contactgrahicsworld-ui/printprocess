// Builds build/MansaPrintAgent.exe (Node Single Executable Application, win-x64).
// Works natively on Windows (CI) and cross-builds from Linux/macOS by downloading the
// official node.exe of the SAME Node version (SEA blobs are version-specific) and
// verifying it against nodejs.org SHASUMS256.txt.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const build = join(root, 'build');
const cache = join(build, 'cache');
mkdirSync(cache, { recursive: true });
const version = process.version; // e.g. v22.23.3
const target = 'win-x64';
const exe = join(build, 'MansaPrintAgent.exe');
const blob = join(build, 'sea-prep.blob');
const bundle = join(root, 'dist', 'agent.cjs');
if (!existsSync(bundle)) throw new Error('dist/agent.cjs missing: run "npm run bundle" first');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function getWindowsNode() {
  if (process.platform === 'win32' && process.arch === 'x64') return process.execPath;
  const zipName = `node-${version}-${target}.zip`;
  const zip = join(cache, zipName);
  const nodeExe = join(cache, `node-${version}-${target}.exe`);
  if (existsSync(nodeExe)) return nodeExe;
  const base = `https://nodejs.org/dist/${version}`;
  console.log(`downloading ${base}/${zipName}`);
  await download(`${base}/${zipName}`, zip);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(` ${zipName}`));
  if (!line) throw new Error(`no checksum for ${zipName}`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = sha256(zip);
  if (expected !== actual) throw new Error(`checksum mismatch for ${zipName}: ${actual} != ${expected}`);
  console.log(`verified sha256 ${actual}`);
  const inner = `node-${version}-${target}/node.exe`;
  // unzip (Linux/macOS) — extract node.exe only
  const out = execFileSync('unzip', ['-p', zip, inner], { maxBuffer: 512 * 1024 * 1024 });
  writeFileSync(nodeExe, out);
  rmSync(zip, { force: true });
  return nodeExe;
}

const seaConfig = join(build, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const nodeExe = await getWindowsNode();
copyFileSync(nodeExe, exe);
if (process.platform === 'win32') {
  // Remove the (now invalid) Authenticode signature if signtool is available; harmless if not.
  try {
    execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' });
  } catch {
    /* signtool not installed: Windows shows an invalid-signature warning only in file properties */
  }
}
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(
  process.execPath,
  [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'],
  { stdio: 'inherit' },
);
const h = sha256(exe);
writeFileSync(`${exe}.sha256`, `${h}  MansaPrintAgent.exe\n`);
console.log(`built ${exe}\nsha256 ${h}\nnode ${version} ${target}`);
