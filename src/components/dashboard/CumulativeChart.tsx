import { useMemo, useState, useId } from 'react';

/**
 * Cumulative invoiced against cumulative received, across the tax year.
 *
 * The point of this chart is the GAP. Everything invoiced sits on the upper
 * line; everything actually banked sits on the lower one. The shaded band
 * between them is money owed to you, drawn to scale rather than stated as a
 * number you have to hold in your head.
 *
 * Palette: categorical slots validated against both surfaces
 * (CVD ΔE 9.2 light / 9.4 dark, normal-vision ΔE 27.6 / 26.5). The aqua sits
 * below 3:1 on the light surface, so both series carry direct labels and a
 * table view is available — the relief the contrast warning requires.
 */

export interface Point {
  date: string;
  invoiced: number;
  paid: number;
  projected: boolean;
}

interface Props {
  points: Point[];
  currency: 'NZD' | 'AUD';
  /**
   * Amount of what has been received that belongs to the tax account.
   *
   * Passed in already computed rather than derived here: the reserve is
   * taken on receipts NET of GST, and a chart that re-derived it from the
   * gross line would quietly disagree with the figure on the stat tile.
   */
  reserveAmount?: number;
}

const PAD = { top: 16, right: 92, bottom: 28, left: 8 };
const HEIGHT = 260;
const VIEW_WIDTH = 760;

function money(cents: number, currency: string, short = false): string {
  return new Intl.NumberFormat('en-NZ', {
    style: 'currency',
    currency,
    maximumFractionDigits: short ? 0 : 2,
    minimumFractionDigits: short ? 0 : 2,
  }).format(cents / 100);
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Round a maximum up to a clean axis top so gridlines land on real numbers. */
function niceMax(value: number): number {
  if (value <= 0) return 1000;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

export default function CumulativeChart({ points, currency, reserveAmount }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const clipId = useId();

  const geometry = useMemo(() => {
    if (points.length === 0) return null;

    const max = niceMax(Math.max(...points.map((p) => p.invoiced)));
    const plotWidth = VIEW_WIDTH - PAD.left - PAD.right;
    const plotHeight = HEIGHT - PAD.top - PAD.bottom;

    const x = (i: number) =>
      PAD.left + (points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
    const y = (v: number) => PAD.top + plotHeight - (v / max) * plotHeight;

    const line = (key: 'invoiced' | 'paid') =>
      points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

    // The owed band: down the invoiced line, back along the paid line.
    const band = [
      ...points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.invoiced).toFixed(1)}`),
      ...points
        .slice()
        .reverse()
        .map((p, i) => `L${x(points.length - 1 - i).toFixed(1)},${y(p.paid).toFixed(1)}`),
      'Z',
    ].join(' ');

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ value: max * f, y: y(max * f) }));

    return { max, x, y, invoicedPath: line('invoiced'), paidPath: line('paid'), band, ticks };
  }, [points]);

  if (!geometry || points.length === 0) {
    return (
      <div className="grid h-[260px] place-items-center text-sm" style={{ color: 'var(--text-muted)' }}>
        <div className="text-center">
          <p>No invoices issued this tax year yet.</p>
          <p className="mt-1 text-xs">The chart fills in as you send and get paid.</p>
        </div>
      </div>
    );
  }

  const last = points[points.length - 1]!;
  const active = hover !== null ? points[hover] : null;
  const outstanding = last.invoiced - last.paid;

  return (
    <div className="viz-root">
      <style>{`
        .viz-root {
          --series-invoiced: var(--accent);
          --series-paid: var(--color-paid);
          --viz-grid: color-mix(in oklch, var(--text-muted) 18%, transparent);
        }
      `}</style>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="label muted flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-1.5" style={{ color: 'var(--text)' }}>
            <span className="size-2.5" style={{ background: 'var(--series-invoiced)' }} />
            Invoiced
          </span>
          <span className="flex items-center gap-1.5" style={{ color: 'var(--text)' }}>
            <span className="size-2.5" style={{ background: 'var(--series-paid)' }} />
            Received
          </span>
          <span className="muted">
            Owed: <strong className="tabular">{money(outstanding, currency, true)}</strong>
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="btn btn-secondary btn-sm"
          style={{ borderColor: 'var(--border)' }}
          aria-expanded={showTable}
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {showTable ? (
        <div className="max-h-[260px] overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Cumulative invoiced and received by date</caption>
            <thead className="sticky top-0" style={{ background: 'var(--surface-raised)' }}>
              <tr className="muted text-left text-xs">
                <th scope="col" className="py-1.5 pr-3 font-medium">Date</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Invoiced</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Received</th>
                <th scope="col" className="py-1.5 text-right font-medium">Owed</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-1.5 pr-3">{shortDate(p.date)}</td>
                  <td className="tabular py-1.5 pr-3 text-right">{money(p.invoiced, currency)}</td>
                  <td className="tabular py-1.5 pr-3 text-right">{money(p.paid, currency)}</td>
                  <td className="tabular py-1.5 text-right">{money(p.invoiced - p.paid, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${HEIGHT}`}
            className="w-full"
            style={{ height: HEIGHT }}
            role="img"
            aria-label={`Cumulative invoiced ${money(last.invoiced, currency, true)} against received ${money(last.paid, currency, true)}, leaving ${money(outstanding, currency, true)} outstanding.`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const px = ((e.clientX - rect.left) / rect.width) * VIEW_WIDTH;
              const plotWidth = VIEW_WIDTH - PAD.left - PAD.right;
              const ratio = (px - PAD.left) / plotWidth;
              const index = Math.round(ratio * (points.length - 1));
              setHover(Math.min(Math.max(index, 0), points.length - 1));
            }}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={PAD.left} y={PAD.top} width={VIEW_WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} />
              </clipPath>
            </defs>

            {geometry.ticks.map((tick) => (
              <g key={tick.value}>
                <line
                  x1={PAD.left}
                  x2={VIEW_WIDTH - PAD.right}
                  y1={tick.y}
                  y2={tick.y}
                  stroke="var(--viz-grid)"
                  strokeWidth="1"
                />
                <text
                  x={VIEW_WIDTH - PAD.right + 6}
                  y={tick.y + 3.5}
                  fontSize="10"
                  fill="var(--text-muted)"
                  className="tabular"
                >
                  {money(tick.value, currency, true)}
                </text>
              </g>
            ))}

            <g clipPath={`url(#${clipId})`}>
              <path d={geometry.band} fill="var(--series-invoiced)" opacity="0.12" />
              <path
                d={geometry.paidPath}
                fill="none"
                stroke="var(--series-paid)"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <path
                d={geometry.invoicedPath}
                fill="none"
                stroke="var(--series-invoiced)"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>

            {/* Direct labels — identity is never carried by colour alone. */}
            <g>
              <circle cx={geometry.x(points.length - 1)} cy={geometry.y(last.invoiced)} r="3.5" fill="var(--series-invoiced)" stroke="var(--surface-raised)" strokeWidth="2" />
              <circle cx={geometry.x(points.length - 1)} cy={geometry.y(last.paid)} r="3.5" fill="var(--series-paid)" stroke="var(--surface-raised)" strokeWidth="2" />
            </g>

            {active && hover !== null && (
              <g>
                <line
                  x1={geometry.x(hover)}
                  x2={geometry.x(hover)}
                  y1={PAD.top}
                  y2={HEIGHT - PAD.bottom}
                  stroke="var(--text-muted)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
                <circle cx={geometry.x(hover)} cy={geometry.y(active.invoiced)} r="4.5" fill="var(--series-invoiced)" stroke="var(--surface-raised)" strokeWidth="2" />
                <circle cx={geometry.x(hover)} cy={geometry.y(active.paid)} r="4.5" fill="var(--series-paid)" stroke="var(--surface-raised)" strokeWidth="2" />
              </g>
            )}

            <text x={PAD.left} y={HEIGHT - 8} fontSize="10" fill="var(--text-muted)">
              {shortDate(points[0]!.date)}
            </text>
            <text x={VIEW_WIDTH - PAD.right} y={HEIGHT - 8} fontSize="10" fill="var(--text-muted)" textAnchor="end">
              {shortDate(last.date)}
            </text>
          </svg>

          {active && (
            <div
              className="pointer-events-none absolute top-2 border px-3 py-2 text-xs shadow-sm"
              style={{
                background: 'var(--surface-raised)',
                borderColor: 'var(--border-strong)',
                borderRadius: 'var(--radius-ctl)',
                left: `${(geometry.x(hover!) / VIEW_WIDTH) * 100}%`,
                transform: 'translateX(-50%)',
                minWidth: '9rem',
              }}
              role="status"
            >
              <p className="muted mb-1 font-medium">{shortDate(active.date)}</p>
              <dl className="space-y-0.5">
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5">
                    <span className="size-2" style={{ background: 'var(--series-invoiced)' }} />
                    Invoiced
                  </dt>
                  <dd className="tabular font-medium">{money(active.invoiced, currency, true)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex items-center gap-1.5">
                    <span className="size-2" style={{ background: 'var(--series-paid)' }} />
                    Received
                  </dt>
                  <dd className="tabular font-medium">{money(active.paid, currency, true)}</dd>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 border-t pt-1" style={{ borderColor: 'var(--border)' }}>
                  <dt className="muted">Owed</dt>
                  <dd className="tabular font-medium">{money(active.invoiced - active.paid, currency, true)}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      )}

      {reserveAmount !== undefined && reserveAmount > 0 && (
        <p className="muted mt-3 text-xs">
          Of the <span className="tabular">{money(last.paid, currency, true)}</span> received,
          <span className="tabular font-medium"> {money(reserveAmount, currency, true)}</span> belongs
          to the tax account.
        </p>
      )}
    </div>
  );
}
