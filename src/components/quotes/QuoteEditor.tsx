import { useState, useMemo } from 'react';

/**
 * Quote editor.
 *
 * The same shape as the invoice editor and the same arithmetic — a quote is
 * priced exactly as the invoice it will become, or the two would disagree at
 * the moment it matters most. Totals here are a preview; the server
 * recalculates through the tax engine regardless.
 */

export interface QuoteClientOption {
  id: string;
  name: string;
  country: string;
  currency: 'NZD' | 'AUD';
  gstTreatment: string;
}

interface Line {
  key: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxable: boolean;
}

interface Props {
  clients: QuoteClientOption[];
  defaults: {
    currency: 'NZD' | 'AUD';
    residenceCurrency: 'NZD' | 'AUD';
    jurisdiction: 'NZ' | 'AU';
    gstRegistered: boolean;
    validDays: number;
    terms: string;
  };
}

const GST_RATES: Record<string, number> = { NZ: 0.15, AU: 0.1 };

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  description: '',
  quantity: '1',
  unit: 'fixed',
  unitPrice: '',
  taxable: true,
});

function parseAmount(value: string): number {
  const parsed = Number.parseFloat(value.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function parseQuantity(value: string): number {
  const parsed = Number.parseFloat(value.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : 0;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency }).format(cents / 100);
}

export default function QuoteEditor({ clients, defaults }: Props) {
  const [clientId, setClientId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [currency, setCurrency] = useState(defaults.currency);
  const [jurisdiction, setJurisdiction] = useState(defaults.jurisdiction);
  const [treatment, setTreatment] = useState('auto');
  const [validDays, setValidDays] = useState(String(defaults.validDays));
  const [terms, setTerms] = useState(defaults.terms);
  const [fxRate, setFxRate] = useState('');
  const [lines, setLines] = useState<Line[]>([newLine()]);

  const client = clients.find((c) => c.id === clientId) ?? null;

  const effectiveTreatment = useMemo(() => {
    if (treatment !== 'auto') return treatment;
    if (!defaults.gstRegistered) return 'not-registered';
    if (!client) return 'standard';
    if (client.gstTreatment !== 'auto') return client.gstTreatment;
    return client.country === jurisdiction ? 'standard' : 'zero-rated-export';
  }, [treatment, client, jurisdiction, defaults.gstRegistered]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let taxableBase = 0;
    for (const line of lines) {
      const amount = Math.round((parseQuantity(line.quantity) / 1000) * parseAmount(line.unitPrice));
      subtotal += amount;
      if (line.taxable) taxableBase += amount;
    }
    const rate = effectiveTreatment === 'standard' ? (GST_RATES[jurisdiction] ?? 0) : 0;
    const gst = Math.round(taxableBase * rate);
    return { subtotal, gst, total: subtotal + gst };
  }, [lines, effectiveTreatment, jurisdiction]);

  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const treatmentLabel: Record<string, string> = {
    standard: jurisdiction === 'NZ' ? 'GST 15%' : 'GST 10%',
    'zero-rated-export': jurisdiction === 'NZ' ? 'Zero-rated export (0%)' : 'GST-free export',
    exempt: 'Exempt',
    'not-registered': 'No GST — not registered',
  };

  return (
    <form method="post" action="/api/quotes" className="grid gap-4 lg:grid-cols-3">
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(
          lines
            .filter((l) => l.description.trim() || parseAmount(l.unitPrice) > 0)
            .map((l) => ({
              description: l.description,
              quantity: parseQuantity(l.quantity),
              unit: l.unit,
              unitPrice: parseAmount(l.unitPrice),
              taxable: l.taxable,
            })),
        )}
      />

      <div className="card space-y-3.5 p-5 lg:col-span-2">
        <div>
          <label htmlFor="title" className="mb-1.5 block text-sm font-medium">
            What is the work
          </label>
          <input
            id="title" name="title" required value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Brand identity and website for Kowhai Studio" className="field"
          />
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <div>
            <label htmlFor="clientId" className="mb-1.5 block text-sm font-medium">Client</label>
            <select
              id="clientId" name="clientId" value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                const next = clients.find((c) => c.id === e.target.value);
                if (next) setCurrency(next.currency);
              }}
              className="field"
            >
              <option value="">No client yet</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="reference" className="mb-1.5 block text-sm font-medium">
              Reference <span className="muted font-normal">(optional)</span>
            </label>
            <input id="reference" name="reference" className="field" />
          </div>
        </div>

        <div>
          <label htmlFor="body" className="mb-1.5 block text-sm font-medium">
            Scope <span className="muted font-normal">— what is and is not included</span>
          </label>
          <textarea
            id="body" name="body" rows={4} value={body}
            onChange={(e) => setBody(e.target.value)} className="field"
            placeholder={'Three logo routes, two rounds of refinement on the chosen one.\nStock photography and print production are not included.'}
          />
          <p className="muted mt-1 text-xs">
            Shown on the quote and on the PDF. The clearer the scope, the shorter the argument later.
          </p>
        </div>

        <div className="space-y-2 border-t pt-3.5" style={{ borderColor: 'var(--border)' }}>
          {lines.map((line) => (
            <div key={line.key} className="grid grid-cols-[1fr_4.5rem_5rem_6rem_2rem] gap-2">
              <input
                aria-label="Description" className="field" placeholder="Discovery and brand strategy"
                value={line.description}
                onChange={(e) => update(line.key, { description: e.target.value })}
              />
              <input
                aria-label="Quantity" className="field tabular" inputMode="decimal"
                value={line.quantity}
                onChange={(e) => update(line.key, { quantity: e.target.value })}
              />
              <select
                aria-label="Unit" className="field" value={line.unit}
                onChange={(e) => update(line.key, { unit: e.target.value })}
              >
                <option value="fixed">fixed</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="items">items</option>
              </select>
              <input
                aria-label="Unit price" className="field tabular" inputMode="decimal" placeholder="0.00"
                value={line.unitPrice}
                onChange={(e) => update(line.key, { unitPrice: e.target.value })}
              />
              {lines.length > 1 && (
                <button
                  type="button" aria-label="Remove line"
                  className="muted text-lg hover:opacity-70"
                  onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                >×</button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="muted text-sm hover:opacity-70"
            onClick={() => setLines((c) => [...c, newLine()])}
          >+ Add line</button>
        </div>

        <div>
          <label htmlFor="terms" className="mb-1.5 block text-sm font-medium">Terms</label>
          <textarea
            id="terms" name="terms" rows={2} value={terms}
            onChange={(e) => setTerms(e.target.value)} className="field"
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="card space-y-3 p-5">
          <h2 className="text-sm font-semibold">Total</h2>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="muted">Subtotal</dt>
              <dd className="tabular">{money(totals.subtotal, currency)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="muted">{treatmentLabel[effectiveTreatment]}</dt>
              <dd className="tabular">{money(totals.gst, currency)}</dd>
            </div>
            <div
              className="flex justify-between gap-3 border-t pt-1.5 text-base font-semibold"
              style={{ borderColor: 'var(--border)' }}
            >
              <dt>Quoted</dt>
              <dd className="tabular">{money(totals.total, currency)}</dd>
            </div>
          </dl>
        </div>

        <div className="card space-y-3.5 p-5">
          <h2 className="text-sm font-semibold">Terms of the quote</h2>

          <div>
            <label htmlFor="validDays" className="mb-1.5 block text-xs font-medium">Holds for</label>
            <div className="flex items-center gap-2">
              <input
                id="validDays" name="validDays" type="number" min="1" max="365"
                value={validDays} onChange={(e) => setValidDays(e.target.value)} className="field"
              />
              <span className="muted shrink-0 text-sm">days</span>
            </div>
            <p className="muted mt-1 text-xs">
              After that it lapses and cannot be accepted, which is what stops a price from
              last winter being held against you.
            </p>
          </div>

          <div>
            <label htmlFor="jurisdiction" className="mb-1.5 block text-xs font-medium">Jurisdiction</label>
            <select
              id="jurisdiction" name="jurisdiction" value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value as 'NZ' | 'AU')} className="field"
            >
              <option value="NZ">New Zealand</option>
              <option value="AU">Australia</option>
            </select>
          </div>

          <div>
            <label htmlFor="currency" className="mb-1.5 block text-xs font-medium">Currency</label>
            <select
              id="currency" name="currency" value={currency}
              onChange={(e) => setCurrency(e.target.value as 'NZD' | 'AUD')} className="field"
            >
              <option value="NZD">NZD</option>
              <option value="AUD">AUD</option>
            </select>
          </div>

          {currency !== defaults.residenceCurrency && (
            <div>
              <label htmlFor="fxRateToResidence" className="mb-1.5 block text-xs font-medium">
                Rate to {defaults.residenceCurrency}
              </label>
              <input
                id="fxRateToResidence" name="fxRateToResidence" className="field tabular"
                inputMode="decimal" placeholder="1.0900"
                value={fxRate} onChange={(e) => setFxRate(e.target.value)}
              />
            </div>
          )}

          <div>
            <label htmlFor="gstTreatment" className="mb-1.5 block text-xs font-medium">GST</label>
            <select
              id="gstTreatment" name="gstTreatment" value={treatment}
              onChange={(e) => setTreatment(e.target.value)} className="field"
            >
              <option value="auto">Automatic ({treatmentLabel[effectiveTreatment]})</option>
              <option value="standard">Standard rate</option>
              <option value="zero-rated-export">Zero-rated / GST-free export</option>
              <option value="exempt">Exempt</option>
              <option value="not-registered">Not registered</option>
            </select>
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary w-full"
        >Save quote</button>
        <p className="muted text-center text-xs">
          Saved as a draft. Nothing reaches the client until you send it.
        </p>
      </div>
    </form>
  );
}
