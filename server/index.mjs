import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { loadEnv } from './env.mjs';
import routes from './routes.mjs';
import { verifyConnectivity, closeDriver } from './db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.APP_ROOT ?? path.resolve(HERE, '..');

// Startup is wrapped in a function rather than run at module top level so the
// same source bundles to CommonJS for the portable Windows build, which does
// not support top-level await.
async function main() {
  loadEnv(ROOT);

  const PORT = Number(process.env.PORT ?? 4173);
  // Loopback only. Binding 0.0.0.0 would trigger the Windows Firewall prompt
  // on first launch, which is exactly the friction this build avoids.
  const HOST = '127.0.0.1';

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

  await app.register(routes);

  // In the packaged build the frontend sits in ./public next to the bundle;
  // in development it is web/dist.
  const staticDir = [
    path.join(HERE, 'public'),
    path.join(ROOT, 'app', 'public'),
    path.join(ROOT, 'web', 'dist'),
  ].find(existsSync);

  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  const status = await verifyConnectivity();
  if (status.ok) {
    console.log(`Connected to CognoDB at ${status.address} (Bolt ${status.protocol}).`);
  } else {
    // Not fatal: the UI renders a banner and keeps polling, which is far more
    // useful to a non-technical user than the process dying at startup.
    console.warn(`Could not reach CognoDB: ${status.error}`);
    console.warn('The app will still start; check .env and reload the page.');
  }

  await app.listen({ port: PORT, host: HOST });
  console.log(`\n  Blast Radius is running at http://localhost:${PORT}\n`);
  if (!staticDir) console.log('  (no built frontend found — run `npm run build:web`)\n');

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await app.close();
      await closeDriver();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(`\nBlast Radius failed to start: ${err.message}\n`);
  process.exit(1);
});
