/**
 * Builds the zip that gets sent over WhatsApp.
 *
 * The result is a folder the recipient unzips and runs by double-clicking a
 * .bat file. No Node install, no admin rights, no PATH changes, no Docker.
 *
 *   node package/build-windows.mjs
 *
 * Every step here exists because of a specific Windows failure mode; see the
 * comments before changing any of it.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, cp, writeFile, readFile, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'package', 'build');
const CACHE = path.join(ROOT, 'package', 'cache');
const STAGE = path.join(OUT, 'BlastRadius');

// Pinned so the artifact is reproducible and so we ship a Node the app is
// actually tested against.
const NODE_VERSION = 'v22.14.0';
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;

// CRLF throughout: cmd.exe mis-parses a .bat saved with LF endings.
const START_BAT = [
  '@echo off',
  'setlocal',
  'title Blast Radius',
  '',
  'rem %~dp0 keeps this working from any folder, including paths with spaces.',
  'cd /d "%~dp0"',
  '',
  'echo.',
  'echo   Blast Radius is starting...',
  'echo.',
  'echo   Leave this window open while you use the app.',
  'echo   Close it when you are done.',
  'echo.',
  '',
  'rem Give the server a moment to bind before the browser opens.',
  'start "" /b cmd /c "timeout /t 3 /nobreak >nul & start \\"\\" http://localhost:4173"',
  '',
  '"%~dp0runtime\\node.exe" "%~dp0app\\server.cjs"',
  '',
  'echo.',
  'echo   The app has stopped.',
  'pause',
].join('\r\n') + '\r\n';

const README_FIRST = [
  'BLAST RADIUS',
  '============',
  '',
  'A dependency-risk explorer. It shows which applications are exposed to a',
  'security advisory through their transitive dependencies.',
  '',
  '',
  'BEFORE YOU EXTRACT  (this step matters)',
  '---------------------------------------',
  'Windows marks files downloaded from the internet as blocked, and that mark',
  'copies onto everything inside the zip.',
  '',
  '  1. Right-click the zip file',
  '  2. Choose Properties',
  '  3. If you see an "Unblock" checkbox at the bottom, tick it',
  '  4. Click OK',
  '',
  'Then extract the zip.',
  '',
  '',
  'TO RUN',
  '------',
  '  1. Open the extracted BlastRadius folder',
  '  2. Double-click START.bat',
  '  3. A black window opens and your browser goes to http://localhost:4173',
  '',
  'Leave the black window open while you use the app. Closing it stops the app.',
  '',
  '',
  'IF WINDOWS SHOWS A BLUE "WINDOWS PROTECTED YOUR PC" BOX',
  '-------------------------------------------------------',
  'Click "More info", then "Run anyway". This appears because the file is not',
  'code-signed, not because anything is wrong with it.',
  '',
  '',
  'IF THE BROWSER SAYS IT CANNOT CONNECT',
  '-------------------------------------',
  'Wait five seconds and reload. The server takes a moment to start.',
  '',
  '',
  'IF THE APP SAYS "DATABASE UNREACHABLE"',
  '--------------------------------------',
  'The app talks to a hosted graph database, so it needs an internet',
  'connection. Check that you are online and reload the page.',
  '',
  '',
  'WHAT IS IN THIS FOLDER',
  '----------------------',
  '  START.bat      launches the app',
  '  .env           connection settings for the database',
  '  runtime\\       a copy of Node.js, so nothing has to be installed',
  '  app\\           the application itself',
  '',
].join('\r\n') + '\r\n';

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchNode() {
  await mkdir(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, NODE_ZIP);

  if (!(await exists(zipPath))) {
    console.log(`  downloading ${NODE_ZIP} ...`);
    const res = await fetch(NODE_URL);
    if (!res.ok) throw new Error(`Failed to download Node: ${res.status} ${res.statusText}`);
    await pipeline(res.body, createWriteStream(zipPath));
  } else {
    console.log(`  using cached ${NODE_ZIP}`);
  }

  // Extract only node.exe. The full archive is ~80 MB of npm and headers we
  // do not ship.
  const inner = `node-${NODE_VERSION}-win-x64/node.exe`;
  execFileSync('unzip', ['-o', '-j', zipPath, inner, '-d', path.join(STAGE, 'runtime')], {
    stdio: 'pipe',
  });

  const { size } = await stat(path.join(STAGE, 'runtime', 'node.exe'));
  console.log(`  node.exe extracted (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  console.log('Building Windows package\n');

  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(STAGE, 'app'), { recursive: true });
  await mkdir(path.join(STAGE, 'runtime'), { recursive: true });

  // 1. Frontend ------------------------------------------------------------
  console.log('- building frontend');
  execFileSync('npx', ['vite', 'build', '--config', 'web/vite.config.js'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  await cp(path.join(ROOT, 'web', 'dist'), path.join(STAGE, 'app', 'public'), {
    recursive: true,
  });

  // 2. Server --------------------------------------------------------------
  // Bundled to one CommonJS file so there is no node_modules tree to copy.
  // That keeps the zip small and avoids Windows' path-length limit, which
  // deeply nested npm folders hit easily.
  console.log('- bundling server');
  await build({
    entryPoints: [path.join(ROOT, 'server', 'index.mjs')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(STAGE, 'app', 'server.cjs'),
    banner: {
      // The bundled CJS output still needs these ESM-only globals.
      js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;',
    },
    define: { 'import.meta.url': '__import_meta_url' },
    logLevel: 'error',
  });
  const bundleSize = (await stat(path.join(STAGE, 'app', 'server.cjs'))).size;
  console.log(`  server.cjs (${(bundleSize / 1024).toFixed(0)} KB)`);

  // 3. Node runtime --------------------------------------------------------
  console.log('- fetching Node runtime');
  await fetchNode();

  // 4. Config + launcher ---------------------------------------------------
  console.log('- writing launcher and config');
  const envPath = path.join(ROOT, '.env');
  if (!(await exists(envPath))) {
    throw new Error(
      'No .env found. The shipped package needs real credentials — create .env from .env.example first.',
    );
  }
  // APP_ROOT pins config lookup to the folder the .bat runs from.
  const env = await readFile(envPath, 'utf8');
  await writeFile(path.join(STAGE, '.env'), env.replace(/\r?\n/g, '\r\n'));
  await writeFile(path.join(STAGE, 'START.bat'), START_BAT);
  await writeFile(path.join(STAGE, 'README-FIRST.txt'), README_FIRST);

  // 5. Zip -----------------------------------------------------------------
  // -x excludes macOS metadata; without it Windows Explorer shows a stray
  // __MACOSX folder and .DS_Store files.
  console.log('- zipping');
  const zipName = 'BlastRadius-windows.zip';
  execFileSync(
    'zip',
    ['-r', '-X', '-q', zipName, 'BlastRadius', '-x', '*.DS_Store', '__MACOSX/*'],
    { cwd: OUT, stdio: 'pipe' },
  );

  const zipSize = (await stat(path.join(OUT, zipName))).size;
  console.log(`\nDone: package/build/${zipName} (${(zipSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log('\nSend this over WhatsApp using the Document picker, not Gallery.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
