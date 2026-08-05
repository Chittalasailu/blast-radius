/**
 * Loads the committed CSVs into CognoDB.
 *
 *   node scripts/seed.mjs --check   verify connectivity only
 *   node scripts/seed.mjs           create constraints, then load everything
 *   node scripts/seed.mjs --wipe    delete existing graph first
 *
 * Idempotent: every write is a MERGE, so re-running converges rather than
 * duplicating.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';

import { loadEnv } from '../server/env.mjs';
import { getDriver, verifyConnectivity, closeDriver, config } from '../server/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(ROOT);

const BATCH = 1000;

function readCsv(name) {
  const text = readFileSync(path.join(ROOT, 'data', name), 'utf8');
  const lines = text.split('\n').filter((l) => l !== '');
  const columns = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const CONSTRAINTS = [
  'CREATE CONSTRAINT package_name IF NOT EXISTS FOR (p:Package) REQUIRE p.name IS UNIQUE',
  'CREATE CONSTRAINT version_key IF NOT EXISTS FOR (v:Version) REQUIRE v.key IS UNIQUE',
  'CREATE CONSTRAINT application_name IF NOT EXISTS FOR (a:Application) REQUIRE a.name IS UNIQUE',
  'CREATE CONSTRAINT team_name IF NOT EXISTS FOR (t:Team) REQUIRE t.name IS UNIQUE',
  'CREATE CONSTRAINT vulnerability_id IF NOT EXISTS FOR (v:Vulnerability) REQUIRE v.id IS UNIQUE',
  'CREATE CONSTRAINT maintainer_handle IF NOT EXISTS FOR (m:Maintainer) REQUIRE m.handle IS UNIQUE',
];

const STEPS = [
  {
    label: 'packages',
    file: 'packages.csv',
    cypher: `
      UNWIND $rows AS row
      MERGE (p:Package {name: row.name})
        SET p.ecosystem = row.ecosystem`,
  },
  {
    label: 'versions',
    file: 'versions.csv',
    cypher: `
      UNWIND $rows AS row
      MERGE (v:Version {key: row.key})
        SET v.version = row.version, v.published = row.published
      WITH v, row
      MATCH (p:Package {name: row.name})
      MERGE (v)-[:OF]->(p)`,
  },
  {
    label: 'REQUIRES edges',
    file: 'requires.csv',
    cypher: `
      UNWIND $rows AS row
      MATCH (a:Version {key: row.from})
      MATCH (b:Version {key: row.to})
      MERGE (a)-[r:REQUIRES]->(b)
        SET r.range = row.range`,
  },
  {
    label: 'teams',
    file: 'teams.csv',
    cypher: `
      UNWIND $rows AS row
      MERGE (t:Team {name: row.name})
        SET t.slug = row.slug`,
  },
  {
    label: 'applications',
    file: 'applications.csv',
    cypher: `
      UNWIND $rows AS row
      MERGE (a:Application {name: row.name})
        SET a.env = row.env
      WITH a, row
      MATCH (t:Team {slug: row.team})
      MERGE (t)-[:OWNS]->(a)`,
  },
  {
    label: 'DEPENDS_ON edges',
    file: 'depends_on.csv',
    cypher: `
      UNWIND $rows AS row
      MATCH (a:Application {name: row.application})
      MATCH (v:Version {key: row.versionKey})
      MERGE (a)-[d:DEPENDS_ON]->(v)
        SET d.range = row.range, d.direct = true`,
  },
  {
    label: 'vulnerabilities',
    file: 'vulnerabilities.csv',
    cypher: `
      UNWIND $rows AS row
      MERGE (v:Vulnerability {id: row.id})
        SET v.aliases   = CASE WHEN row.aliases = '' THEN [] ELSE split(row.aliases, ' ') END,
            v.severity  = row.severity,
            v.cvss      = row.cvss,
            v.summary   = row.summary,
            v.published = row.published`,
  },
  {
    label: 'AFFECTS edges',
    file: 'affects.csv',
    cypher: `
      UNWIND $rows AS row
      MATCH (v:Vulnerability {id: row.vulnerabilityId})
      MATCH (ver:Version {key: row.versionKey})
      MERGE (v)-[:AFFECTS]->(ver)`,
  },
  {
    label: 'maintainers',
    file: 'maintainers.csv',
    cypher: `
      UNWIND $rows AS row
      MERGE (:Maintainer {handle: row.handle})`,
  },
  {
    label: 'MAINTAINS edges',
    file: 'maintains.csv',
    cypher: `
      UNWIND $rows AS row
      MATCH (m:Maintainer {handle: row.handle})
      MATCH (p:Package {name: row.packageName})
      MERGE (m)-[:MAINTAINS]->(p)`,
  },
];

const COUNTS = `
MATCH (p:Package)        WITH count(p) AS packages
MATCH (v:Version)        WITH packages, count(v) AS versions
MATCH (a:Application)    WITH packages, versions, count(a) AS applications
MATCH (t:Team)           WITH packages, versions, applications, count(t) AS teams
MATCH (vu:Vulnerability) WITH packages, versions, applications, teams, count(vu) AS vulnerabilities
MATCH (m:Maintainer)     WITH packages, versions, applications, teams, vulnerabilities, count(m) AS maintainers
MATCH ()-[r:REQUIRES]->() WITH packages, versions, applications, teams, vulnerabilities, maintainers, count(r) AS requires
MATCH ()-[af:AFFECTS]->() RETURN packages, versions, applications, teams, vulnerabilities, maintainers, requires, count(af) AS affects
`;

async function main() {
  const args = process.argv.slice(2);

  const { uri } = config();
  console.log(`Target: ${uri}`);

  const status = await verifyConnectivity();
  if (!status.ok) {
    console.error(`\n  Cannot reach CognoDB: ${status.error}`);
    console.error('  Check COGNODB_URI / COGNODB_PASSWORD in .env.\n');
    process.exit(1);
  }
  console.log(`Connected: ${status.address}, Bolt ${status.protocol}\n`);
  if (args.includes('--check')) return;

  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

  try {
    if (args.includes('--wipe')) {
      process.stdout.write('Wiping existing graph... ');
      let deleted;
      do {
        const res = await session.run(
          'MATCH (n) WITH n LIMIT 10000 DETACH DELETE n RETURN count(n) AS deleted',
        );
        deleted = res.records[0].get('deleted');
      } while (Number(deleted) > 0);
      console.log('done.');
    }

    process.stdout.write('Creating constraints... ');
    for (const c of CONSTRAINTS) await session.run(c);
    console.log('done.\n');

    for (const step of STEPS) {
      const rows = readCsv(step.file);
      const t0 = Date.now();
      for (let i = 0; i < rows.length; i += BATCH) {
        await session.run(step.cypher, { rows: rows.slice(i, i + BATCH) });
        process.stdout.write(
          `  ${step.label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`,
        );
      }
      console.log(`  ${step.label}: ${rows.length} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s        `);
    }

    const res = await session.run(COUNTS);
    console.log('\nGraph now contains:');
    const counts = res.records[0].toObject();
    for (const [k, v] of Object.entries(counts)) {
      console.log(`  ${k.padEnd(16)} ${Number(v).toLocaleString()}`);
    }
    const totalNodes =
      Number(counts.packages) + Number(counts.versions) + Number(counts.applications) +
      Number(counts.teams) + Number(counts.vulnerabilities) + Number(counts.maintainers);
    console.log(`  ${'TOTAL NODES'.padEnd(16)} ${totalNodes.toLocaleString()}`);
  } finally {
    await session.close();
    await closeDriver();
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeDriver();
  process.exit(1);
});
