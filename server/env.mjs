import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env loader. Deliberately dependency-free: the Windows bundle ships
 * a single bundled file next to a .env, and pulling in dotenv just to parse
 * three lines is not worth the bytes.
 *
 * Real environment variables always win over the file, so a hosting platform
 * can inject config without a .env present.
 */
export function loadEnv(rootDir) {
  const file = path.join(rootDir, '.env');
  if (!existsSync(file)) return;

  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
