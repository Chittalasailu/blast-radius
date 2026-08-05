/**
 * Every Cypher statement in the application lives here as a named constant and
 * takes its inputs as `$` parameters. Nothing is built by string
 * concatenation, so user input can never alter query structure.
 *
 * Traversal depth caps are deliberate: they bound worst-case work on a free
 * c0 instance while staying well above the depth real dependency trees reach.
 */

// --- Reference data used to populate the UI's pickers -----------------------

export const LIST_VULNERABILITIES = /* cypher */ `
MATCH (v:Vulnerability)-[:AFFECTS]->(bad:Version)-[:OF]->(pkg:Package)
WITH v, collect(DISTINCT pkg.name) AS packages, count(DISTINCT bad) AS versionCount
RETURN v.id            AS id,
       v.aliases       AS aliases,
       v.severity      AS severity,
       v.cvss          AS cvss,
       v.summary       AS summary,
       v.published     AS published,
       packages        AS packages,
       versionCount    AS versionCount
ORDER BY
  CASE v.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MODERATE' THEN 2 ELSE 3 END,
  v.published DESC
LIMIT $limit
`;

export const LIST_APPLICATIONS = /* cypher */ `
MATCH (app:Application)
OPTIONAL MATCH (team:Team)-[:OWNS]->(app)
OPTIONAL MATCH (app)-[:DEPENDS_ON]->(direct:Version)
RETURN app.name             AS name,
       app.env              AS env,
       team.name            AS team,
       count(DISTINCT direct) AS directDependencies
ORDER BY app.name
`;

/**
 * OPTIONAL MATCH rather than MATCH throughout: a chained grouped aggregation
 * over an empty label returns *zero* rows, which would leave the UI with no
 * counts at all on a partially seeded database. OPTIONAL MATCH always yields
 * one row, and count(null) is 0.
 */
export const OVERVIEW = /* cypher */ `
OPTIONAL MATCH (p:Package)        WITH count(p) AS packages
OPTIONAL MATCH (v:Version)        WITH packages, count(v) AS versions
OPTIONAL MATCH (a:Application)    WITH packages, versions, count(a) AS applications
OPTIONAL MATCH (vu:Vulnerability) WITH packages, versions, applications, count(vu) AS vulnerabilities
OPTIONAL MATCH ()-[r:REQUIRES]->() WITH packages, versions, applications, vulnerabilities, count(r) AS requires
RETURN packages, versions, applications, vulnerabilities, requires
`;

// --- Query 1: blast radius (headline; multi-hop, relational-awkward) --------

/**
 * From one advisory, find every application that can reach an affected
 * version through any depth of transitive dependency, and return the shortest
 * justification path for each. This is the query the whole app exists for.
 */
export const BLAST_RADIUS = /* cypher */ `
MATCH (vuln:Vulnerability {id: $vulnerabilityId})-[:AFFECTS]->(bad:Version)-[:OF]->(badPkg:Package)
MATCH path = shortestPath( (app:Application)-[:DEPENDS_ON|REQUIRES*1..9]->(bad) )
OPTIONAL MATCH (team:Team)-[:OWNS]->(app)
WITH app, team, badPkg, bad, path, length(path) AS hops
ORDER BY hops ASC
WITH app, team,
     collect({
       hops: hops,
       viaPackage: badPkg.name + '@' + bad.version,
       chain: [n IN nodes(path) | coalesce(n.name, n.key)]
     }) AS routes
RETURN app.name        AS application,
       app.env         AS env,
       team.name       AS team,
       routes[0].hops       AS hops,
       routes[0].viaPackage AS viaPackage,
       routes[0].chain      AS chain,
       size(routes)         AS affectedPaths
ORDER BY hops ASC, application ASC
`;

/** The same traversal, shaped as nodes/links for the force-directed view. */
export const BLAST_RADIUS_GRAPH = /* cypher */ `
MATCH (vuln:Vulnerability {id: $vulnerabilityId})-[:AFFECTS]->(bad:Version)
MATCH path = shortestPath( (app:Application)-[:DEPENDS_ON|REQUIRES*1..9]->(bad) )
WITH collect(path) AS paths, collect(DISTINCT bad) AS badVersions
UNWIND paths AS path
UNWIND nodes(path) AS n
WITH badVersions, collect(DISTINCT n) AS allNodes, paths
UNWIND paths AS p2
UNWIND relationships(p2) AS r
WITH badVersions, allNodes, collect(DISTINCT r) AS allRels
RETURN
  [n IN allNodes |
    CASE
      WHEN n:Application THEN {id: n.name, label: n.name, type: 'Application', env: n.env, affected: false}
      ELSE {
        id: n.key,
        label: n.key,
        type: 'Version',
        env: null,
        affected: any(b IN badVersions WHERE b.key = n.key)
      }
    END
  ] AS nodes,
  [r IN allRels | {
    source: coalesce(startNode(r).name, startNode(r).key),
    target: coalesce(endNode(r).name, endNode(r).key),
    type:   type(r)
  }] AS links
`;

// --- Query 2: why is this dependency here? ---------------------------------

export const DEPENDENCY_PATH = /* cypher */ `
MATCH (app:Application {name: $applicationName})
MATCH (target:Version)-[:OF]->(pkg:Package {name: $packageName})
MATCH path = shortestPath( (app)-[:DEPENDS_ON|REQUIRES*1..9]->(target) )
WITH path, target, pkg, length(path) AS hops
ORDER BY hops ASC
LIMIT 1
RETURN hops                                          AS hops,
       pkg.name + '@' + target.version               AS resolved,
       [n IN nodes(path) | coalesce(n.name, n.key)]  AS chain,
       [r IN relationships(path) | type(r)]          AS edgeTypes
`;

// --- Query 3: bus factor (two independent traversals joined) ---------------

/**
 * Packages with a single maintainer, ranked by how many applications can
 * transitively reach them. The awkward part for a relational engine is that
 * this joins an aggregate over maintainers against an aggregate over an
 * unbounded traversal.
 */
export const BUS_FACTOR = /* cypher */ `
MATCH (m:Maintainer)-[:MAINTAINS]->(pkg:Package)
WITH pkg, count(DISTINCT m) AS maintainerCount, collect(DISTINCT m.handle)[0] AS soleMaintainer
WHERE maintainerCount = 1
MATCH (pkg)<-[:OF]-(v:Version)
MATCH (app:Application)-[:DEPENDS_ON|REQUIRES*1..6]->(v)
WITH pkg, soleMaintainer, count(DISTINCT app) AS reachingApplications
WHERE reachingApplications >= $minApplications
RETURN pkg.name             AS package,
       soleMaintainer       AS maintainer,
       reachingApplications AS reachingApplications
ORDER BY reachingApplications DESC, package ASC
LIMIT $limit
`;

// --- Query 4: shared transitive surface between two applications -----------

export const SHARED_SURFACE = /* cypher */ `
MATCH (a:Application {name: $applicationA})-[:DEPENDS_ON|REQUIRES*1..7]->(:Version)-[:OF]->(p:Package)
WITH collect(DISTINCT p.name) AS aPackages
MATCH (b:Application {name: $applicationB})-[:DEPENDS_ON|REQUIRES*1..7]->(:Version)-[:OF]->(q:Package)
WITH aPackages, collect(DISTINCT q.name) AS bPackages
WITH aPackages, bPackages, [n IN aPackages WHERE n IN bPackages] AS shared
RETURN shared                     AS sharedPackages,
       size(shared)               AS sharedCount,
       size(aPackages)            AS aCount,
       size(bPackages)            AS bCount,
       size([n IN aPackages WHERE NOT n IN bPackages]) AS aOnlyCount,
       size([n IN bPackages WHERE NOT n IN aPackages]) AS bOnlyCount
`;

// --- Query 5: upgrade impact ----------------------------------------------

export const UPGRADE_IMPACT = /* cypher */ `
MATCH (target:Version)-[:OF]->(pkg:Package {name: $packageName})
WHERE $version IS NULL OR target.version = $version
MATCH path = shortestPath( (app:Application)-[:DEPENDS_ON|REQUIRES*1..9]->(target) )
OPTIONAL MATCH (team:Team)-[:OWNS]->(app)
WITH app, team, target, length(path) AS hops
ORDER BY hops ASC
WITH app, team, collect({hops: hops, version: target.version}) AS routes
RETURN app.name          AS application,
       app.env           AS env,
       team.name         AS team,
       routes[0].hops    AS hops,
       routes[0].version AS resolvedVersion
ORDER BY hops ASC, application ASC
`;

/** Package name autocomplete for the two package-scoped queries. */
export const SEARCH_PACKAGES = /* cypher */ `
MATCH (pkg:Package)
WHERE toLower(pkg.name) CONTAINS toLower($term)
OPTIONAL MATCH (pkg)<-[:OF]-(v:Version)
RETURN pkg.name AS name, collect(DISTINCT v.version) AS versions
ORDER BY size(pkg.name) ASC, pkg.name ASC
LIMIT $limit
`;
