/**
 * All network access goes through here so the "database unreachable" case is
 * handled in exactly one place and every panel renders the same banner.
 */

export class ApiError extends Error {
  constructor(message, { unavailable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.unavailable = unavailable;
  }
}

export async function get(path, params) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError('The app could not reach its own server.', { unavailable: true });
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(body.message ?? `Request failed (${res.status}).`, {
      unavailable: body.error === 'database_unavailable',
    });
  }
  return body;
}

export const api = {
  health: () => get('/api/health'),
  overview: () => get('/api/overview'),
  vulnerabilities: () => get('/api/vulnerabilities', { limit: 200 }),
  applications: () => get('/api/applications'),
  blastRadius: (id) => get(`/api/blast-radius/${encodeURIComponent(id)}`),
  busFactor: (minApplications) => get('/api/bus-factor', { minApplications, limit: 25 }),
  sharedSurface: (a, b) => get('/api/shared-surface', { a, b }),
  upgradeImpact: (pkg, version) => get('/api/upgrade-impact', { package: pkg, version }),
  dependencyPath: (application, pkg) =>
    get('/api/dependency-path', { application, package: pkg }),
  searchPackages: (q) => get('/api/packages', { q, limit: 15 }),
};
