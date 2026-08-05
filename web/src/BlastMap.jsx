import { useEffect, useRef } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceRadial,
} from 'd3-force';

/**
 * The blast map.
 *
 * A conventional force-directed graph settles into a hairball where distance
 * from the vulnerability is not readable. Here the simulation is still
 * force-directed — link, charge and collision forces all run — but a radial
 * force pins every node to the ring matching its hop distance from the
 * affected package at the centre.
 *
 * The result is that the one number that drives the decision (how many hops
 * away are we?) is encoded as the most legible visual channel on the canvas.
 */

const RING_GAP = 74;
const COLORS = {
  ink: '#131a24',
  inkFaint: '#78838d',
  rule: '#c8cdc6',
  ruleSoft: '#dde1da',
  surface: '#fafbf9',
  accent: '#1f6f6b',
  critical: '#a81e4d',
};

/** Breadth-first hop distance from the affected versions back to applications. */
function computeDepths(nodes, links) {
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    adjacency.get(l.source)?.push(l.target);
    adjacency.get(l.target)?.push(l.source);
  }

  const depth = new Map();
  const seeds = nodes.filter((n) => n.affected).map((n) => n.id);
  const queue = seeds.map((id) => [id, 0]);
  seeds.forEach((id) => depth.set(id, 0));

  while (queue.length > 0) {
    const [id, d] = queue.shift();
    for (const next of adjacency.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push([next, d + 1]);
    }
  }
  return depth;
}

export default function BlastMap({ graph, highlightApplication }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph?.nodes?.length) return undefined;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const nodes = graph.nodes.map((n) => ({ ...n }));
    const links = graph.links
      .filter((l) => nodes.some((n) => n.id === l.source) && nodes.some((n) => n.id === l.target))
      .map((l) => ({ ...l }));

    // Use the filtered links, not graph.links: a link pointing at a node that
    // was dropped would contribute a hop distance for a node that is never
    // drawn, pulling real nodes onto the wrong ring.
    const depths = computeDepths(nodes, links);
    const maxDepth = Math.max(1, ...[...depths.values()]);
    nodes.forEach((n) => {
      n.depth = depths.get(n.id) ?? maxDepth;
    });

    const dpr = window.devicePixelRatio || 1;
    let width = canvas.clientWidth;
    let height = canvas.clientHeight;

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const cx = () => width / 2;
    const cy = () => height / 2;
    const ringRadius = (depth) => {
      const usable = Math.min(width, height) / 2 - 28;
      return Math.min(depth * RING_GAP, usable * (depth / Math.max(maxDepth, 1)));
    };

    const simulation = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(46).strength(0.35))
      .force('charge', forceManyBody().strength(-90))
      .force('collide', forceCollide(14))
      .force(
        'radial',
        forceRadial((d) => ringRadius(d.depth), cx(), cy()).strength(0.92),
      )
      .alpha(1)
      .alphaDecay(reduceMotion ? 0.35 : 0.028);

    const ctx = canvas.getContext('2d');

    function draw() {
      ctx.clearRect(0, 0, width, height);

      // Rings, outermost first, each labelled with its hop count.
      for (let d = maxDepth; d >= 1; d -= 1) {
        const r = ringRadius(d);
        if (r <= 0) continue;
        ctx.beginPath();
        ctx.arc(cx(), cy(), r, 0, Math.PI * 2);
        ctx.strokeStyle = d % 2 === 0 ? COLORS.ruleSoft : COLORS.rule;
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = COLORS.inkFaint;
        ctx.font = '600 9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${d} HOP${d === 1 ? '' : 'S'}`, cx() + r + 6, cy() - 3);
      }

      ctx.strokeStyle = COLORS.ruleSoft;
      ctx.lineWidth = 1;
      for (const l of links) {
        const isHot =
          highlightApplication &&
          (l.source.id === highlightApplication || l.target.id === highlightApplication);
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.strokeStyle = isHot ? COLORS.accent : COLORS.ruleSoft;
        ctx.lineWidth = isHot ? 1.75 : 1;
        ctx.stroke();
      }

      for (const n of nodes) {
        const isApp = n.type === 'Application';
        const isHighlighted = highlightApplication && n.id === highlightApplication;
        const r = n.affected ? 8 : isApp ? 6.5 : 3.5;

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.affected
          ? COLORS.critical
          : isApp
            ? COLORS.accent
            : COLORS.surface;
        ctx.fill();
        ctx.strokeStyle = n.affected ? COLORS.critical : isApp ? COLORS.accent : COLORS.rule;
        ctx.lineWidth = isHighlighted ? 3 : 1.25;
        ctx.stroke();

        // Only applications and the epicentre carry labels; intermediate
        // package versions would turn the canvas into noise.
        if (isApp || n.affected) {
          ctx.fillStyle = COLORS.ink;
          ctx.font = `${isHighlighted ? '700' : '500'} 10px ui-monospace, Consolas, monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(n.label, n.x, n.y - r - 5);
        }
      }
    }

    simulation.on('tick', () => {
      frameRef.current = requestAnimationFrame(draw);
    });

    const observer = new ResizeObserver(() => {
      resize();
      simulation
        .force('radial', forceRadial((d) => ringRadius(d.depth), cx(), cy()).strength(0.92))
        .alpha(0.4)
        .restart();
    });
    observer.observe(canvas);

    return () => {
      observer.disconnect();
      simulation.stop();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [graph, highlightApplication]);

  return (
    <div className="map-frame">
      <canvas ref={canvasRef} role="img" aria-label="Blast radius map: applications plotted by hop distance from the affected package" />
      <div className="map-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: COLORS.critical }} />
          affected version
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: COLORS.accent }} />
          application
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: COLORS.surface, border: `1px solid ${COLORS.rule}` }} />
          transitive dependency
        </span>
      </div>
    </div>
  );
}
