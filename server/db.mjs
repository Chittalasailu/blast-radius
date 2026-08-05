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

/** Missing or blank connection settings, as opposed to a failure to connect. */
export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function config() {
  const uri = process.env.COGNODB_URI;
  const user = process.env.COGNODB_USER || 'cognodb';
  const password = process.env.COGNODB_PASSWORD;

  if (!uri || !password) {
    throw new ConfigurationError(
      'Connection settings are missing. The .env file next to the app must set COGNODB_URI and COGNODB_PASSWORD.',
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
    return {
      ok: false,
      configured: !(err instanceof ConfigurationError),
      error: err.message,
    };
  }
}

/**
 * Runs a read query. Every call passes parameters through the driver's
 * `$`-parameter binding — no Cypher is ever built by string concatenation.
 */
export async function read(cypher, params = {}) {
  let session;
  try {
    session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  } catch (err) {
    // Driver construction fails when config is missing; surface it as such
    // rather than as a generic query failure.
    throw err;
  }

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
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  return (
    err instanceof DatabaseUnavailableError ||
    code.includes('ServiceUnavailable') ||
    code.includes('SessionExpired') ||
    code.includes('Neo.ClientError.Security.Unauthorized') ||
    code.includes('Neo.ClientError.Security.AuthenticationRateLimit') ||
    /ServiceUnavailable|routing|Could not perform discovery|connection|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|authentication failure|Unauthorized/i.test(
      message,
    )
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
