/**
 * One-off source builder. Walks the public npm registry from a set of root
 * packages, resolves the dependency graph, cross-references OSV.dev for
 * advisories, and layers on a synthetic org (teams -> applications).
 *
 * Output is a set of CSVs committed to the repo, so `npm run seed` is
 * reproducible and needs no network access to the registry.
 *
 *   node data/fetch-sources.mjs
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = 'https://registry.npmjs.org';
const OSV = 'https://api.osv.dev/v1/querybatch';

// Roots chosen to produce deep, overlapping trees with known historical CVEs.
const ROOTS = [
  'express', 'webpack', 'jest', 'eslint', 'react-scripts', 'next',
  'axios', 'lodash', 'mongoose', 'socket.io', 'nodemailer', 'puppeteer',
  'sequelize', 'passport', 'body-parser', 'jsonwebtoken', 'ws', 'got',
  'commander', 'chalk', 'yargs', 'inquirer', 'rimraf', 'semver',
  'typescript', 'rollup', 'babel-loader', 'postcss', 'tailwindcss', 'vite',
  'prisma', 'knex', 'redis', 'bull', 'winston', 'pino',
  'sharp', 'multer', 'cors', 'helmet',
];

const MAX_DEPTH = 6;
const CONCURRENCY = 12;

/** Registry packument cache: name -> { versions, maintainers, latest } */
const packuments = new Map();

async function getPackument(name) {
  if (packuments.has(name)) return packuments.get(name);
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!res.ok) {
    packuments.set(name, null);
    return null;
  }
  const json = await res.json();
  const doc = {
    name,
    latest: json['dist-tags']?.latest ?? null,
    versions: json.versions ?? {},
    time: json.time ?? {},
  };
  packuments.set(name, doc);
  return doc;
}

/**
 * npm ranges are not fully resolvable without a solver. We take the *lowest*
 * published version satisfying the range's major, which is what a lockfile
 * that has not been refreshed in years actually pins. That is both realistic
 * for the use case (stale dependencies are the whole point of the app) and
 * the reason real CVEs land on nodes in this graph rather than none at all.
 */
function resolveRange(doc, range) {
  if (!doc) return null;
  const all = Object.keys(doc.versions).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  if (all.length === 0) return doc.latest;

  const sorted = all.sort(cmpVersion);
  if (!range || range === '*' || range === 'latest') {
    // Roots: pin roughly two-thirds back through release history.
    return sorted[Math.floor(sorted.length * 0.35)] ?? doc.latest;
  }

  const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return sorted[Math.floor(sorted.length * 0.35)] ?? doc.latest;
  const [, maj] = m;

  const sameMajor = sorted.filter((v) => v.split('.')[0] === maj);
  const pool = sameMajor.length > 0 ? sameMajor : sorted;
  return pool[0] ?? doc.latest;
}

/**
 * OSV range bounds are not always three-part ("1.2", "0"), so parts are padded
 * before comparison. Without the padding a missing part yields NaN and every
 * comparison against it silently reads as "not less than".
 */
function parts(v) {
  const nums = String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  return [0, 1, 2].map((i) => (Number.isFinite(nums[i]) ? nums[i] : 0));
}

function cmpVersion(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** name@version -> { name, version, published, deps: [[name, range]] } */
const nodes = new Map();
const edges = [];

async function walk(name, range, depth) {
  const doc = await getPackument(name);
  const version = resolveRange(doc, range);
  if (!doc || !version || !doc.versions[version]) return null;

  const key = `${name}@${version}`;
  if (nodes.has(key)) return key;

  nodes.set(key, {
    name,
    version,
    published: (doc.time[version] ?? '').slice(0, 10),
  });

  if (depth >= MAX_DEPTH) return key;

  const deps = doc.versions[version].dependencies ?? {};
  const entries = Object.entries(deps);

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const slice = entries.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      slice.map(([dn, dr]) => walk(dn, dr, depth + 1).catch(() => null)),
    );
    resolved.forEach((childKey, j) => {
      if (childKey) edges.push({ from: key, to: childKey, range: slice[j][1] });
    });
  }

  return key;
}

async function fetchAdvisories(packageNames) {
  const found = [];
  const BATCH = 100;

  for (let i = 0; i < packageNames.length; i += BATCH) {
    const batch = packageNames.slice(i, i + BATCH);
    const res = await fetch(OSV, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: batch.map((n) => ({ package: { name: n, ecosystem: 'npm' } })),
      }),
    });
    if (!res.ok) continue;
    const { results = [] } = await res.json();

    results.forEach((r, j) => {
      (r.vulns ?? []).slice(0, 4).forEach((v) => {
        found.push({ id: v.id, packageName: batch[j], modified: v.modified });
      });
    });
    process.stdout.write(`  advisories ${Math.min(i + BATCH, packageNames.length)}/${packageNames.length}\r`);
  }
  return found;
}

/**
 * OSV describes npm advisories with introduced/fixed *ranges*, not an
 * enumerated version list, so containment has to be evaluated rather than
 * matched by string.
 */
function inRange(version, introduced, fixed) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  if (introduced && introduced !== '0' && cmpVersion(version, introduced) < 0) return false;
  if (fixed && cmpVersion(version, fixed) >= 0) return false;
  return true;
}

async function hydrateAdvisory(id) {
  const res = await fetch(`https://api.osv.dev/v1/vulns/${id}`);
  if (!res.ok) return null;
  const v = await res.json();

  const cvss = v.severity?.find((s) => s.type?.startsWith('CVSS'))?.score ?? '';
  const severity =
    v.database_specific?.severity ??
    (cvss.includes('/C:H') ? 'HIGH' : 'MODERATE');

  /** [{ packageName, versions?: string[], ranges: [{introduced, fixed}] }] */
  const affected = [];
  for (const a of v.affected ?? []) {
    if (a.package?.ecosystem !== 'npm') continue;
    const ranges = [];
    for (const r of a.ranges ?? []) {
      if (r.type !== 'SEMVER' && r.type !== 'ECOSYSTEM') continue;
      let introduced = null;
      for (const ev of r.events ?? []) {
        if (ev.introduced !== undefined) introduced = ev.introduced;
        if (ev.fixed !== undefined) {
          ranges.push({ introduced, fixed: ev.fixed });
          introduced = null;
        }
        if (ev.last_affected !== undefined) {
          ranges.push({ introduced, fixed: null, lastAffected: ev.last_affected });
          introduced = null;
        }
      }
      if (introduced !== null) ranges.push({ introduced, fixed: null });
    }
    affected.push({
      packageName: a.package.name,
      versions: a.versions ?? [],
      ranges,
    });
  }

  return {
    id: v.id,
    aliases: (v.aliases ?? []).filter((a) => a.startsWith('CVE-')),
    severity: String(severity).toUpperCase(),
    cvss,
    summary: (v.summary ?? v.details ?? '').split('\n')[0].slice(0, 240),
    published: (v.published ?? '').slice(0, 10),
    affected,
  };
}

/** Returns the version keys in our graph that this advisory actually affects. */
function matchAffected(advisory, versionsByPackage) {
  const matched = new Set();
  for (const a of advisory.affected) {
    const ours = versionsByPackage.get(a.packageName);
    if (!ours) continue;

    for (const version of ours) {
      const enumerated = a.versions.includes(version);
      const ranged = a.ranges.some((r) =>
        r.lastAffected
          ? inRange(version, r.introduced, null) && cmpVersion(version, r.lastAffected) <= 0
          : inRange(version, r.introduced, r.fixed),
      );
      if (enumerated || ranged) matched.add(`${a.packageName}@${version}`);
    }
  }
  return [...matched];
}

// ---------------------------------------------------------------------------
// Synthetic org layer. Deterministic so re-running produces identical CSVs.
// ---------------------------------------------------------------------------

const TEAMS = [
  { name: 'Platform', slug: 'platform' },
  { name: 'Payments', slug: 'payments' },
  { name: 'Growth', slug: 'growth' },
  { name: 'Data', slug: 'data' },
  { name: 'Internal Tools', slug: 'tools' },
];

const APPLICATIONS = [
  { name: 'checkout-web', team: 'payments', env: 'production', roots: ['next', 'axios', 'jsonwebtoken', 'helmet'] },
  { name: 'payments-api', team: 'payments', env: 'production', roots: ['express', 'sequelize', 'jsonwebtoken', 'pino'] },
  { name: 'ledger-worker', team: 'payments', env: 'production', roots: ['bull', 'redis', 'knex', 'winston'] },
  { name: 'marketing-site', team: 'growth', env: 'production', roots: ['next', 'tailwindcss', 'sharp'] },
  { name: 'campaign-service', team: 'growth', env: 'production', roots: ['express', 'nodemailer', 'mongoose', 'got'] },
  { name: 'referral-api', team: 'growth', env: 'staging', roots: ['express', 'axios', 'lodash'] },
  { name: 'events-ingest', team: 'data', env: 'production', roots: ['ws', 'socket.io', 'pino', 'redis'] },
  { name: 'etl-pipeline', team: 'data', env: 'production', roots: ['knex', 'prisma', 'commander', 'yargs'] },
  { name: 'report-builder', team: 'data', env: 'staging', roots: ['puppeteer', 'sharp', 'express'] },
  { name: 'admin-console', team: 'tools', env: 'production', roots: ['react-scripts', 'axios', 'passport'] },
  { name: 'oncall-bot', team: 'tools', env: 'production', roots: ['axios', 'chalk', 'commander', 'got'] },
  { name: 'design-system', team: 'platform', env: 'production', roots: ['rollup', 'postcss', 'typescript'] },
  { name: 'build-orchestrator', team: 'platform', env: 'production', roots: ['webpack', 'babel-loader', 'semver', 'rimraf'] },
  { name: 'ci-runner', team: 'platform', env: 'production', roots: ['jest', 'eslint', 'yargs', 'rimraf'] },
  { name: 'gateway', team: 'platform', env: 'production', roots: ['express', 'cors', 'helmet', 'ws'] },
  { name: 'docs-portal', team: 'tools', env: 'staging', roots: ['vite', 'tailwindcss', 'typescript'] },
  { name: 'search-api', team: 'data', env: 'production', roots: ['express', 'redis', 'got', 'lodash'] },
  { name: 'notification-hub', team: 'growth', env: 'production', roots: ['nodemailer', 'bull', 'pino'] },
];

// ---------------------------------------------------------------------------

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

async function main() {
  console.log(`Walking ${ROOTS.length} roots to depth ${MAX_DEPTH}...`);
  const rootKeys = new Map();
  for (const root of ROOTS) {
    const key = await walk(root, null, 0);
    if (key) rootKeys.set(root, key);
    process.stdout.write(`  ${root} -> ${nodes.size} versions\r`);
  }
  console.log(`\nResolved ${nodes.size} versions, ${edges.length} REQUIRES edges.`);

  const packageNames = [...new Set([...nodes.values()].map((n) => n.name))];
  console.log(`Querying OSV for ${packageNames.length} packages...`);
  const hits = await fetchAdvisories(packageNames);
  const uniqueIds = [...new Set(hits.map((h) => h.id))].slice(0, 500);
  console.log(`\nHydrating ${uniqueIds.length} advisories...`);

  const advisories = [];
  for (let i = 0; i < uniqueIds.length; i += 16) {
    const batch = await Promise.all(uniqueIds.slice(i, i + 16).map((id) => hydrateAdvisory(id).catch(() => null)));
    advisories.push(...batch.filter(Boolean));
    process.stdout.write(`  hydrated ${advisories.length}/${uniqueIds.length}\r`);
  }

  // package name -> versions of it that exist in our graph
  const versionsByPackage = new Map();
  for (const n of nodes.values()) {
    if (!versionsByPackage.has(n.name)) versionsByPackage.set(n.name, []);
    versionsByPackage.get(n.name).push(n.version);
  }

  // Keep only advisories that actually touch a version present in our graph.
  const affects = [];
  const keptAdvisories = [];
  for (const a of advisories) {
    const matched = matchAffected(a, versionsByPackage);
    if (matched.length === 0) continue;
    keptAdvisories.push(a);
    matched.forEach((v) => affects.push({ vulnerabilityId: a.id, versionKey: v }));
  }
  console.log(`${keptAdvisories.length} advisories affect versions in the graph (${affects.length} AFFECTS edges).`);

  // Maintainers: derive deterministically from package name so the CSV is stable.
  const MAINTAINER_POOL = [
    'kowalski', 'devora', 'ilyas', 'ren', 'hoshino', 'mbaye', 'quintero',
    'okonkwo', 'vasquez', 'lindqvist', 'aritra', 'sokolova', 'nakamura',
    'ferreira', 'haddad', 'novak', 'tanaka', 'oyelaran', 'petrov', 'singh',
  ];
  const maintains = [];
  const maintainers = new Set();
  packageNames.forEach((name, i) => {
    // Deterministic 1-3 maintainers; ~30% get exactly one (the bus-factor set).
    const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const count = hash % 10 < 3 ? 1 : 1 + (hash % 3);
    for (let k = 0; k < count; k += 1) {
      const handle = MAINTAINER_POOL[(hash + k * 7 + i) % MAINTAINER_POOL.length];
      maintainers.add(handle);
      maintains.push({ handle, packageName: name });
    }
  });

  const dependsOn = [];
  for (const app of APPLICATIONS) {
    for (const root of app.roots) {
      const key = rootKeys.get(root);
      if (key) dependsOn.push({ application: app.name, versionKey: key, range: '^' + key.split('@').at(-1) });
    }
  }

  const files = {
    'packages.csv': toCsv(
      packageNames.map((name) => ({ name, ecosystem: 'npm' })),
      ['name', 'ecosystem'],
    ),
    'versions.csv': toCsv(
      [...nodes.entries()].map(([key, v]) => ({ key, ...v })),
      ['key', 'name', 'version', 'published'],
    ),
    'requires.csv': toCsv(edges, ['from', 'to', 'range']),
    'vulnerabilities.csv': toCsv(
      keptAdvisories.map((a) => ({ ...a, aliases: a.aliases.join(' ') })),
      ['id', 'aliases', 'severity', 'cvss', 'summary', 'published'],
    ),
    'affects.csv': toCsv(affects, ['vulnerabilityId', 'versionKey']),
    'teams.csv': toCsv(TEAMS, ['name', 'slug']),
    'applications.csv': toCsv(APPLICATIONS, ['name', 'team', 'env']),
    'depends_on.csv': toCsv(dependsOn, ['application', 'versionKey', 'range']),
    'maintainers.csv': toCsv([...maintainers].map((handle) => ({ handle })), ['handle']),
    'maintains.csv': toCsv(maintains, ['handle', 'packageName']),
  };

  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(OUT, file), content);
    console.log(`  wrote ${file} (${content.split('\n').length - 2} rows)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
