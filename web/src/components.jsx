/** Shared state components. Every panel uses these so states stay consistent. */

export function Banner({ title, children }) {
  return (
    <div className="banner" role="alert">
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </div>
  );
}

export function ErrorState({ error }) {
  if (!error) return null;
  return (
    <Banner title={error.unavailable ? 'Database unreachable' : 'Query failed'}>
      {error.message}
    </Banner>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <span className="label">{title}</span>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function Skeleton({ rows = 6 }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${100 - (i % 4) * 12}%` }} />
      ))}
    </div>
  );
}

export function Chain({ steps }) {
  if (!steps?.length) return null;
  return (
    <span className="chain">
      {steps.map((step, i) => (
        <span key={`${step}-${i}`}>
          {i > 0 ? <span className="arrow">/</span> : null}
          <span className={i === steps.length - 1 ? 'terminal' : undefined}>{step}</span>
        </span>
      ))}
    </span>
  );
}

export function EnvPill({ env }) {
  return <span className={`pill ${env === 'production' ? 'production' : ''}`}>{env}</span>;
}
