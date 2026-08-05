import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Chain, Empty, EnvPill, ErrorState, Skeleton } from './components.jsx';

/** Small helper: run an async call, tracking loading/error/data. */
function useAsync(fn, deps, { immediate = true } = {}) {
  const [state, setState] = useState({ loading: immediate, data: null, error: null });

  const run = async (...args) => {
    setState({ loading: true, data: null, error: null });
    try {
      setState({ loading: false, data: await fn(...args), error: null });
    } catch (error) {
      setState({ loading: false, data: null, error });
    }
  };

  useEffect(() => {
    if (immediate) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return [state, run];
}

// --- Query 3 ---------------------------------------------------------------

export function BusFactorPanel() {
  const [minApps, setMinApps] = useState(2);
  const [{ loading, data, error }, run] = useAsync(
    () => api.busFactor(minApps),
    [],
    { immediate: true },
  );

  return (
    <>
      <div className="headline">
        <span className="label">Query 3 · Maintainer concentration</span>
        <h1>Single-maintainer choke points</h1>
        <p>
          Packages kept by one person that many applications reach transitively. These are the
          dependencies where an abandoned or compromised account propagates furthest.
        </p>
      </div>

      <div className="section-head">
        <span className="label">Results</span>
      </div>

      <div className="controls">
        <label className="field">
          <span className="label">Reached by at least</span>
          <input
            type="number"
            min="1"
            max="18"
            value={minApps}
            onChange={(e) => setMinApps(Number(e.target.value))}
          />
        </label>
        <button className="btn" onClick={() => run()} disabled={loading}>
          {loading ? 'Running' : 'Run query'}
        </button>
      </div>

      <ErrorState error={error} />
      {loading ? <Skeleton rows={8} /> : null}

      {!loading && data?.length === 0 ? (
        <Empty title="No choke points at this threshold">
          Lower the application count to widen the search.
        </Empty>
      ) : null}

      {!loading && data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Package</th>
              <th>Sole maintainer</th>
              <th className="num">Applications reached</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.package}>
                <td className="mono">{row.package}</td>
                <td className="mono">{row.maintainer}</td>
                <td className="num">{row.reachingApplications}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

// --- Query 4 ---------------------------------------------------------------

export function SharedSurfacePanel({ applications }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [{ loading, data, error }, run] = useAsync(
    () => api.sharedSurface(a, b),
    [],
    { immediate: false },
  );

  useEffect(() => {
    if (applications.length >= 2 && !a && !b) {
      setA(applications[0].name);
      setB(applications[1].name);
    }
  }, [applications, a, b]);

  return (
    <>
      <div className="headline">
        <span className="label">Query 4 · Overlap</span>
        <h1>Shared transitive surface</h1>
        <p>
          Packages both applications reach through any depth of dependency. Everything in this set
          is a fix that lands in two places at once.
        </p>
      </div>

      <div className="section-head">
        <span className="label">Compare</span>
      </div>

      <div className="controls">
        <label className="field">
          <span className="label">Application A</span>
          <select value={a} onChange={(e) => setA(e.target.value)}>
            {applications.map((app) => (
              <option key={app.name} value={app.name}>{app.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Application B</span>
          <select value={b} onChange={(e) => setB(e.target.value)}>
            {applications.map((app) => (
              <option key={app.name} value={app.name}>{app.name}</option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={() => run()} disabled={loading || !a || !b || a === b}>
          {loading ? 'Running' : 'Compare'}
        </button>
      </div>

      <ErrorState error={error} />
      {loading ? <Skeleton rows={5} /> : null}

      {!loading && !data && !error ? (
        <Empty title="Nothing compared yet">
          Choose two applications and run the comparison.
        </Empty>
      ) : null}

      {!loading && data ? (
        <>
          <div className="meta-row">
            <div>
              <span className="label">Shared packages</span>
              <div className="value">{data.sharedCount}</div>
            </div>
            <div>
              <span className="label">{a} only</span>
              <div className="value">{data.aOnlyCount}</div>
            </div>
            <div>
              <span className="label">{b} only</span>
              <div className="value">{data.bOnlyCount}</div>
            </div>
          </div>

          {data.sharedCount === 0 ? (
            <Empty title="No overlap">
              These two applications share no transitive dependencies.
            </Empty>
          ) : (
            <>
              <div className="section-head">
                <span className="label">Shared packages</span>
              </div>
              <p className="chain">{data.sharedPackages.join('  ·  ')}</p>
            </>
          )}
        </>
      ) : null}
    </>
  );
}

// --- Query 5 ---------------------------------------------------------------

export function UpgradeImpactPanel() {
  const [pkg, setPkg] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [{ loading, data, error }, run] = useAsync(
    () => api.upgradeImpact(pkg, null),
    [],
    { immediate: false },
  );

  useEffect(() => {
    if (pkg.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const rows = await api.searchPackages(pkg);
        if (!cancelled) setSuggestions(rows);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pkg]);

  return (
    <>
      <div className="headline">
        <span className="label">Query 5 · Change planning</span>
        <h1>Upgrade impact</h1>
        <p>
          Every application that reaches this package, and how deep it sits. This is the retest list
          before the version is bumped.
        </p>
      </div>

      <div className="section-head">
        <span className="label">Target package</span>
      </div>

      <div className="controls">
        <label className="field">
          <span className="label">Package name</span>
          <input
            list="package-suggestions"
            value={pkg}
            placeholder="lodash"
            onChange={(e) => setPkg(e.target.value)}
          />
          <datalist id="package-suggestions">
            {suggestions.map((s) => (
              <option key={s.name} value={s.name} />
            ))}
          </datalist>
        </label>
        <button className="btn" onClick={() => run()} disabled={loading || pkg.length < 2}>
          {loading ? 'Running' : 'Trace impact'}
        </button>
      </div>

      <ErrorState error={error} />
      {loading ? <Skeleton rows={6} /> : null}

      {!loading && !data && !error ? (
        <Empty title="No package selected">
          Type a package name to see which applications would need a retest.
        </Empty>
      ) : null}

      {!loading && data?.length === 0 ? (
        <Empty title="Nothing reaches this package">
          No application depends on it, directly or transitively.
        </Empty>
      ) : null}

      {!loading && data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Application</th>
              <th>Team</th>
              <th>Environment</th>
              <th>Resolved version</th>
              <th className="num">Hops</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.application}>
                <td className="mono">{row.application}</td>
                <td>{row.team ?? '—'}</td>
                <td><EnvPill env={row.env} /></td>
                <td className="mono">{row.resolvedVersion}</td>
                <td className="num">{row.hops}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

// --- Query 2 ---------------------------------------------------------------

export function DependencyPathPanel({ applications }) {
  const [app, setApp] = useState('');
  const [pkg, setPkg] = useState('');
  const [{ loading, data, error }, run] = useAsync(
    () => api.dependencyPath(app, pkg),
    [],
    { immediate: false },
  );

  useEffect(() => {
    if (applications.length && !app) setApp(applications[0].name);
  }, [applications, app]);

  return (
    <>
      <div className="headline">
        <span className="label">Query 2 · Justification</span>
        <h1>Why is this package here?</h1>
        <p>
          The shortest chain from an application to a package it never asked for directly. This is
          the answer to “we do not use this, why is it in our lockfile?”
        </p>
      </div>

      <div className="section-head">
        <span className="label">Trace</span>
      </div>

      <div className="controls">
        <label className="field">
          <span className="label">Application</span>
          <select value={app} onChange={(e) => setApp(e.target.value)}>
            {applications.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Package</span>
          <input value={pkg} placeholder="ms" onChange={(e) => setPkg(e.target.value)} />
        </label>
        <button className="btn" onClick={() => run()} disabled={loading || !app || !pkg}>
          {loading ? 'Tracing' : 'Trace path'}
        </button>
      </div>

      <ErrorState error={error} />
      {loading ? <Skeleton rows={3} /> : null}

      {!loading && data === null && !error ? (
        <Empty title="No path found">
          This application does not reach that package, or the package is not in the graph.
        </Empty>
      ) : null}

      {!loading && data ? (
        <>
          <div className="meta-row">
            <div>
              <span className="label">Hops</span>
              <div className="value">{data.hops}</div>
            </div>
            <div>
              <span className="label">Resolved</span>
              <div className="value mono" style={{ fontSize: 16 }}>{data.resolved}</div>
            </div>
          </div>
          <div className="section-head">
            <span className="label">Chain</span>
          </div>
          <Chain steps={data.chain} />
        </>
      ) : null}
    </>
  );
}
