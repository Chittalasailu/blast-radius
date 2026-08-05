import { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import BlastMap from './BlastMap.jsx';
import { Chain, Empty, EnvPill, ErrorState, Skeleton } from './components.jsx';
import {
  BusFactorPanel,
  DependencyPathPanel,
  SharedSurfacePanel,
  UpgradeImpactPanel,
} from './panels.jsx';

const TABS = [
  { id: 'blast', label: 'Blast radius' },
  { id: 'path', label: 'Dependency path' },
  { id: 'bus', label: 'Bus factor' },
  { id: 'shared', label: 'Shared surface' },
  { id: 'upgrade', label: 'Upgrade impact' },
];

function StatusBar({ health, overview }) {
  const connected = health?.ok;
  return (
    <header className="statusbar">
      <span className="wordmark">
        Blast<span>·</span>Radius
      </span>
      <span className="spacer" />
      {overview ? (
        <>
          <span className="stat"><b>{overview.applications}</b> applications</span>
          <span className="stat"><b>{overview.packages.toLocaleString()}</b> packages</span>
          <span className="stat"><b>{overview.requires.toLocaleString()}</b> dependency edges</span>
          <span className="stat"><b>{overview.vulnerabilities}</b> advisories</span>
        </>
      ) : null}
      <span className="stat">
        <span className={`dot ${connected ? 'ok' : ''}`} />
        {connected ? 'CognoDB connected' : 'CognoDB unreachable'}
      </span>
    </header>
  );
}

function AdvisoryRail({ advisories, loading, selected, onSelect }) {
  const [term, setTerm] = useState('');

  const filtered = useMemo(() => {
    if (!term.trim()) return advisories;
    const q = term.toLowerCase();
    return advisories.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        (a.aliases ?? []).some((x) => x.toLowerCase().includes(q)) ||
        a.summary.toLowerCase().includes(q) ||
        a.packages.some((p) => p.toLowerCase().includes(q)),
    );
  }, [advisories, term]);

  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="label">Advisories · {advisories.length}</span>
        <input
          className="search"
          value={term}
          placeholder="Filter by CVE, package or text"
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>
      <div className="rail-list">
        {loading ? (
          <div style={{ padding: 16 }}><Skeleton rows={10} /></div>
        ) : null}

        {!loading && filtered.length === 0 ? (
          <div style={{ padding: 16 }}>
            <Empty title="No matches">Clear the filter to see every advisory.</Empty>
          </div>
        ) : null}

        {filtered.map((a) => (
          <button
            key={a.id}
            className="advisory"
            aria-current={selected === a.id}
            onClick={() => onSelect(a.id)}
          >
            <div className="advisory-top">
              <span className={`sev ${a.severity.toLowerCase()}`}>{a.severity}</span>
              <span className="advisory-id">{a.aliases?.[0] ?? a.id}</span>
            </div>
            <div className="advisory-summary">{a.summary}</div>
            <div className="advisory-pkgs">{a.packages.join(', ')}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function BlastPanel({ advisories, selectedId, onSelect, loading }) {
  const [result, setResult] = useState(null);
  const [state, setState] = useState({ loading: false, error: null });
  const [highlight, setHighlight] = useState(null);

  const advisory = advisories.find((a) => a.id === selectedId);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setState({ loading: true, error: null });
    setHighlight(null);

    api
      .blastRadius(selectedId)
      .then((data) => {
        if (!cancelled) {
          setResult(data);
          setState({ loading: false, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setResult(null);
          setState({ loading: false, error });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (!selectedId) {
    return (
      <Empty title="Pick an advisory">
        Choose one from the list to map which applications it reaches and how far it has to travel.
      </Empty>
    );
  }

  const apps = result?.applications ?? [];
  const production = apps.filter((a) => a.env === 'production').length;
  const deepest = apps.length ? Math.max(...apps.map((a) => a.hops)) : 0;

  return (
    <>
      <div className="headline">
        <span className="label">
          Query 1 · {advisory?.severity ?? ''} · {advisory?.id}
        </span>
        <h1>{advisory?.summary ?? selectedId}</h1>
        <p>
          Every application that can reach an affected version through any depth of transitive
          dependency, with the shortest path that gets it there.
        </p>
      </div>

      <ErrorState error={state.error} />

      {state.loading ? (
        <div style={{ marginTop: 32 }}><Skeleton rows={8} /></div>
      ) : null}

      {!state.loading && !state.error ? (
        <>
          <div className="meta-row">
            <div>
              <span className="label">Applications exposed</span>
              <div className="value">{apps.length}</div>
            </div>
            <div>
              <span className="label">In production</span>
              <div className="value">{production}</div>
            </div>
            <div>
              <span className="label">Deepest path</span>
              <div className="value">{deepest} {deepest === 1 ? 'hop' : 'hops'}</div>
            </div>
            <div>
              <span className="label">Affected packages</span>
              <div className="value mono" style={{ fontSize: 14 }}>
                {advisory?.packages.join(', ')}
              </div>
            </div>
          </div>

          {apps.length === 0 ? (
            <div style={{ marginTop: 24 }}>
              <Empty title="Nothing to contain">
                No application reaches an affected version. This advisory does not apply to the
                current dependency graph.
              </Empty>
            </div>
          ) : (
            <>
              <BlastMap graph={result.graph} highlightApplication={highlight} />

              <div className="section-head">
                <span className="label">Exposed applications</span>
                <span className="label">Hover a row to trace it on the map</span>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>Application</th>
                    <th>Team</th>
                    <th>Environment</th>
                    <th className="num">Hops</th>
                    <th>Shortest path</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((row) => (
                    <tr
                      key={row.application}
                      onMouseEnter={() => setHighlight(row.application)}
                      onMouseLeave={() => setHighlight(null)}
                    >
                      <td className="mono">{row.application}</td>
                      <td>{row.team ?? '—'}</td>
                      <td><EnvPill env={row.env} /></td>
                      <td className="num">{row.hops}</td>
                      <td><Chain steps={row.chain} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      ) : null}
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState('blast');
  const [health, setHealth] = useState(null);
  const [overview, setOverview] = useState(null);
  const [advisories, setAdvisories] = useState([]);
  const [applications, setApplications] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [bootstrap, setBootstrap] = useState({ loading: true, error: null });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const status = await api.health().catch(() => ({ ok: false }));
      if (cancelled) return;
      setHealth(status);

      try {
        const [ov, vulns, apps] = await Promise.all([
          api.overview(),
          api.vulnerabilities(),
          api.applications(),
        ]);
        if (cancelled) return;
        setOverview(ov);
        setAdvisories(vulns);
        setApplications(apps);
        setSelectedId((current) => current ?? vulns[0]?.id ?? null);
        setBootstrap({ loading: false, error: null });
      } catch (error) {
        if (!cancelled) setBootstrap({ loading: false, error });
      }
    }

    load();
    const timer = setInterval(() => {
      api.health().then(setHealth).catch(() => setHealth({ ok: false }));
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="app">
      <StatusBar health={health} overview={overview} />

      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="body">
          <AdvisoryRail
            advisories={advisories}
            loading={bootstrap.loading}
            selected={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setTab('blast');
            }}
          />

          <main className="main">
            <ErrorState error={bootstrap.error} />

            {bootstrap.error ? null : (
              <>
                {tab === 'blast' ? (
                  <BlastPanel
                    advisories={advisories}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    loading={bootstrap.loading}
                  />
                ) : null}
                {tab === 'path' ? <DependencyPathPanel applications={applications} /> : null}
                {tab === 'bus' ? <BusFactorPanel /> : null}
                {tab === 'shared' ? <SharedSurfacePanel applications={applications} /> : null}
                {tab === 'upgrade' ? <UpgradeImpactPanel /> : null}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
