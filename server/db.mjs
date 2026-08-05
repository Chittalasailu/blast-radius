import neo4j from 'neo4j-driver';

/**
 * CognoDB speaks Bolt and is driven by the official Neo4j driver, so this is
 * the standard driver setup with no vendor-specific shims.
 */

let driver = null;
let lastError = null;

export class DatabaseUnavailableError extends Error {
  constructor(cause) {
    super('The graph database is unreachable.');
    this.name = 'DatabaseUnavailableError';
    this.cause = cause;
  }
}

export function config() {
  const uri = process.env.COGNODB_URI;
  const user = process.env.COGNODB_USER || 'cognodb';
  const password = process.env.COGNODB_PASSWORD;

  if (!uri || !password) {
    throw new Error(
      'COGNODB_URI and COGNODB_PASSWORD must be set. Copy .env.example to .env and fill it in.',
    );
  }
  return { uri, user, password };
}

export function getDriver() {
  if (driver) return driver;
  const { uri, user, password } = config();

  driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    maxConnectionPoolSize: 20,
    connectionAcquisitionTimeout: 15_000,
    connectionTimeout: 10_000,
    // Values comfortably below 2^53 here, so plain JS numbers are safe and
    // callers never have to unwrap Integer objects.
    disableLosslessIntegers: true,
  });
  return driver;
}

export async function verifyConnectivity() {
  try {
    const info = await getDriver().getServerInfo();
    lastError = null;
    return { ok: true, address: info.address, protocol: info.protocolVersion };
  } catch (err) {
    lastError = err;
    return { ok: false, error: err.message };
  }
}

/**
 * Runs a read query. Every call passes parameters through the driver's
 * `$`-parameter binding — no Cypher is ever built by string concatenation.
 */
export async function read(cypher, params = {}) {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.executeRead((tx) => tx.run(cypher, params));
    return result.records.map((r) => r.toObject());
  } catch (err) {
    if (isConnectivityError(err)) throw new DatabaseUnavailableError(err);
    throw err;
  } finally {
    await session.close();
  }
}

export function isConnectivityError(err) {
  const code = err?.code ?? '';
  return (
    err instanceof DatabaseUnavailableError ||
    code.includes('ServiceUnavailable') ||
    code.includes('SessionExpired') ||
    code.includes('Neo.ClientError.Security.Unauthorized') ||
    err?.name === 'Neo4jError' && /routing|connection|ECONNREFUSED|ENOTFOUND|timed out/i.test(err.message)
  );
}

export function getLastError() {
  return lastError;
}

export async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
