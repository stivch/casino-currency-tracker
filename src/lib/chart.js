// Plotting a session's running profit.
//
// The baseline is the balance the session opened with, so zero on this chart is
// "you are where you started". Everything above it is profit and everything
// below it is loss — which is the shape a player actually reasons about, and
// the reason the fill is closed to the baseline rather than to the bottom of
// the box: the area *is* the amount, above or below.
//
// Pure geometry, no DOM. The caller decides what to do with the paths.

/**
 * @param values  Running profit, one point per bet, oldest first.
 * @returns {{line:string, area:string, zeroY:number, min:number, max:number}|null}
 *          null when there is nothing to draw — one point is a dot, not a shape.
 */
export function plotSeries(values, { width = 600, height = 200, pad = 6 } = {}) {
  if (!Array.isArray(values) || values.length < 2) return null;

  // Zero is forced into range: a session that never went negative still needs
  // its baseline on screen, or the chart is a line with nothing to read it
  // against.
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const inner = height - pad * 2;

  const x = (i) => (i / (values.length - 1)) * width;
  const y = (v) => pad + (1 - (v - min) / span) * inner;

  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = +y(0).toFixed(1);

  return {
    line,
    // Closed along the baseline, not the floor.
    area: `${line} L${width.toFixed(1)},${zeroY} L0,${zeroY} Z`,
    zeroY,
    min,
    max,
    width,
    height,
  };
}

/**
 * Evenly thin a series to at most `limit` points, always keeping the first and
 * the last.
 *
 * Used when archiving: a 4,000-bet session is not worth 4,000 numbers in
 * storage, and at chart resolution it does not look any different. Keeping the
 * ends matters because the last point is the session's final P/L — the figure
 * printed next to the chart.
 */
export function downsample(values, limit = 60) {
  if (!Array.isArray(values)) return [];
  if (values.length <= limit) return values.slice();
  if (limit < 2) return [values[values.length - 1]];

  const out = [];
  const step = (values.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) out.push(values[Math.round(i * step)]);
  return out;
}
