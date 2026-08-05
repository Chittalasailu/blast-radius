/**
 * Runs every query the application exposes against the live instance and
 * asserts the results are actually shaped the way the UI expects.
 *
 * The depth assertion is the important one: the assignment requires a genuine
 * multi-hop traversal, so a run where nothing exceeds 2 hops is a failure of
 * the seed data even though every query technically succeeded.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../server/env.mjs';
import { read, verifyConnectivity, closeDriver } from '../server/db.mjs';
import * as Q from '../server/queries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function timed(label, fn) {
  const t0 = Date.now();
  const rows = await fn();
  const ms = Date.now() - t0;
  console.log(`\n${label}  (${ms} ms, ${rows.length} rows)`);
  return rows;
}

async function main() {
  const status = await verifyConnectivity();
  if (!status.ok) {
    console.error(`Cannot reach CognoDB: ${status.error}`);
    process.exit(1);
  }
  console.log(`Connected to ${status.address}, Bolt ${status.protocol}`);

  const [overview] = await read(Q.OVERVIEW);
  console.log('\nGraph size:', overview);
  check('graph has applications', Number(overview.applications) > 0);
  check('graph has advisories', Number(overview.vulnerabilities) > 0);
  check('graph has dependency edges', Number(overview.requires) > 100);

  // --- pick an advisory that actually reaches something ---------------------
  const advisories = await timed('LIST_VULNERABILITIES', () =>
    read(Q.LIST_VULNERABILITIES, { limit: 200 }));
  check('advisory list is non-empty', advisories.length > 0);

  let chosen = null;
  let blast = [];
  for (const a of advisories) {
    const rows = await read(Q.BLAST_RADIUS, { vulnerabilityId: a.id });
    if (rows.length > 0) {
      chosen = a;
      blast = rows;
      const deep = rows.filter((r) => Number(r.hops) >= 3);
      if (deep.length > 0) break; // prefer one that proves the multi-hop case
    }
  }

  console.log(`\nBLAST_RADIUS  (advisory ${chosen?.id})`);
  check('blast radius returns applications', blast.length > 0, `${blast.length} applications`);

  const maxHops = blast.length ? Math.max(...blast.map((r) => Number(r.hops))) : 0;
  check(
    'at least one application is 3+ hops away (multi-hop requirement)',
    maxHops >= 3,
    `deepest path = ${maxHops} hops`,
  );
  check(
    'paths include a readable chain',
    blast.every((r) => Array.isArray(r.chain) && r.chain.length >= 2),
  );

  const graph = await read(Q.BLAST_RADIUS_GRAPH, { vulnerabilityId: chosen.id });
  check('graph payload has nodes', (graph[0]?.nodes?.length ?? 0) > 0, `${graph[0]?.nodes?.length} nodes`);
  check('graph payload has links', (graph[0]?.links?.length ?? 0) > 0, `${graph[0]?.links?.length} links`);
  check('graph marks at least one affected node', graph[0]?.nodes?.some((n) => n.affected));

  // --- Query 2 --------------------------------------------------------------
  const sampleApp = blast[0]?.application;
  const deepestChain = blast.find((r) => Number(r.hops) === maxHops)?.chain ?? [];
  const targetPackage = (deepestChain.at(-1) ?? '').split('@')[0];

  const pathRows = await timed('DEPENDENCY_PATH', () =>
    read(Q.DEPENDENCY_PATH, { applicationName: sampleApp, packageName: targetPackage }));
  check('dependency path resolves', pathRows.length > 0, `${sampleApp} -> ${targetPackage}`);

  // --- Query 3 --------------------------------------------------------------
  const bus = await timed('BUS_FACTOR', () =>
    read(Q.BUS_FACTOR, { minApplications: 1, limit: 25 }));
  check('bus factor returns choke points', bus.length > 0, `top: ${bus[0]?.package}`);

  // --- Query 4 --------------------------------------------------------------
  const apps = await read(Q.LIST_APPLICATIONS);
  const shared = await timed('SHARED_SURFACE', () =>
    read(Q.SHARED_SURFACE, { applicationA: apps[0].name, applicationB: apps[1].name }));
  check(
    'shared surface computes',
    shared.length > 0,
    `${apps[0].name} vs ${apps[1].name}: ${shared[0]?.sharedCount} shared`,
  );

  // --- Query 5 --------------------------------------------------------------
  const upgrade = await timed('UPGRADE_IMPACT', () =>
    read(Q.UPGRADE_IMPACT, { packageName: targetPackage, version: null }));
  check('upgrade impact returns a retest list', upgrade.length > 0, `${upgrade.length} applications`);

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check(s) failed.\n`,
  );
  await closeDriver();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDriver();
  process.exit(1);
});
