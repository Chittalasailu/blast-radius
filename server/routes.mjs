import {
  read,
  verifyConnectivity,
  DatabaseUnavailableError,
  ConfigurationError,
} from './db.mjs';
import * as Q from './queries.mjs';

/**
 * Every handler funnels failures through `guard` so a misconfigured or
 * unreachable database produces a structured 503 the UI can render as a
 * banner, never a stack trace and never a crashed process.
 */
async function guard(reply, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConfigurationError) {
      reply.code(503);
      return { error: 'database_unavailable', message: err.message };
    }
    if (err instanceof DatabaseUnavailableError) {
      reply.code(503);
      return {
        error: 'database_unavailable',
        message:
          'Cannot reach the CognoDB instance. Check that you are online and that the settings in .env are correct.',
      };
    }
    if (err.statusCode === 400) {
      reply.code(400);
      return { error: 'bad_request', message: err.message };
    }
    reply.code(500);
    return { error: 'query_failed', message: err.message };
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    const err = new Error(`"${field}" is required.`);
    err.statusCode = 400;
    throw err;
  }
  return value.trim();
}

export default async function routes(fastify) {
  fastify.get('/api/health', async () => {
    const status = await verifyConnectivity();
    return status;
  });

  fastify.get('/api/overview', async (req, reply) =>
    guard(reply, async () => {
      const [row] = await read(Q.OVERVIEW);
      return row ?? {};
    }));

  fastify.get('/api/vulnerabilities', async (req, reply) =>
    guard(reply, () => read(Q.LIST_VULNERABILITIES, { limit: Number(req.query.limit ?? 100) })));

  fastify.get('/api/applications', async (req, reply) =>
    guard(reply, () => read(Q.LIST_APPLICATIONS)));

  fastify.get('/api/packages', async (req, reply) =>
    guard(reply, () =>
      read(Q.SEARCH_PACKAGES, {
        term: String(req.query.q ?? ''),
        limit: Number(req.query.limit ?? 20),
      })));

  // --- Query 1 -------------------------------------------------------------

  fastify.get('/api/blast-radius/:vulnerabilityId', async (req, reply) =>
    guard(reply, async () => {
      const vulnerabilityId = requireString(req.params.vulnerabilityId, 'vulnerabilityId');
      const [rows, graph] = await Promise.all([
        read(Q.BLAST_RADIUS, { vulnerabilityId }),
        read(Q.BLAST_RADIUS_GRAPH, { vulnerabilityId }),
      ]);
      return {
        vulnerabilityId,
        applications: rows,
        graph: graph[0] ?? { nodes: [], links: [] },
      };
    }));

  // --- Query 2 -------------------------------------------------------------

  fastify.get('/api/dependency-path', async (req, reply) =>
    guard(reply, async () => {
      const applicationName = requireString(req.query.application, 'application');
      const packageName = requireString(req.query.package, 'package');
      const rows = await read(Q.DEPENDENCY_PATH, { applicationName, packageName });
      return rows[0] ?? null;
    }));

  // --- Query 3 -------------------------------------------------------------

  fastify.get('/api/bus-factor', async (req, reply) =>
    guard(reply, () =>
      read(Q.BUS_FACTOR, {
        minApplications: Number(req.query.minApplications ?? 2),
        limit: Number(req.query.limit ?? 25),
      })));

  // --- Query 4 -------------------------------------------------------------

  fastify.get('/api/shared-surface', async (req, reply) =>
    guard(reply, async () => {
      const applicationA = requireString(req.query.a, 'a');
      const applicationB = requireString(req.query.b, 'b');
      const rows = await read(Q.SHARED_SURFACE, { applicationA, applicationB });
      return rows[0] ?? { sharedPackages: [], sharedCount: 0 };
    }));

  // --- Query 5 -------------------------------------------------------------

  fastify.get('/api/upgrade-impact', async (req, reply) =>
    guard(reply, () =>
      read(Q.UPGRADE_IMPACT, {
        packageName: requireString(req.query.package, 'package'),
        version: req.query.version ? String(req.query.version) : null,
      })));
}
