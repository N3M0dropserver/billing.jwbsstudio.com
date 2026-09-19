import { useState, useMemo } from 'react';

/**
 * Invoice editor.
 *
 * Totals recompute as you type, using the same rounding the server will
 * apply, so what you see before saving is what gets stored. The server
 * recalculates anyway — this is a preview, not the source of truth.
 */

export interface ClientOption {
  id: string;
  name: string;
  country: string;
  currency: 'NZD' | 'AUD';
  paymentTermsDays: number | null;
  hourlyRate: number | null;
  gstTreatment: string;
}

export interface TemplateOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface UnbilledEntry {
  id: string;
  description: string;
  minutes: number;
  clientId: string | null;
  startedAt: string;
  hourlyRate: number | null;
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
  clients: ClientOption[];
  unbilled: UnbilledEntry[];
  /** The account's invoice templates, for the design picker. */
  templates: TemplateOption[];
  defaults: {
    currency: 'NZD' | 'AUD';
    /** Currency the tax figures are kept in — follows tax residence. */
    residenceCurrency: 'NZD' | 'AUD';
    jurisdiction: 'NZ' | 'AU';
    paymentTermsDays: number;
    hourlyRate: number;
    gstRegistered: boolean;
    terms: string;
  };
  invoice?: {
    id: string;
    clientId: string | null;
    issuedOn: string;
    dueOn: string;
    currency: 'NZD' | 'AUD';
    jurisdiction: 'NZ' | 'AU';
    gstTreatment: string;
    fxRateToResidence: number;
    reference: string;
    notes: string;
    terms: string;
    templateId: string | null;
    lines: Array<{ description: string; quantity: number; unit: string; unitPrice: number; taxable: boolean }>;
  };
}

const GST_RATES: Record<string, number> = { NZ: 0.15, AU: 0.10 };

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  description: '',
  quantity: '1',
  unit: 'hours',
  unitPrice: '',
  taxable: true,
});

function parseAmount(value: string): number {
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function parseQuantity(value: string): number {
  const parsed = Number.parseFloat(value.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : 0;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency }).format(cents / 100);
}

export default function InvoiceEditor({ clients, unbilled, templates, defaults, invoice }: Props) {
  /** Named on the "Default" option, so the picker says what it will actually use. */
  const defaultTemplateName = templates.find((template) => template.isDefault)?.name ?? '';

  const [clientId, setClientId] = useState(invoice?.clientId ?? '');
  const [issuedOn, setIssuedOn] = useState(invoice?.issuedOn ?? new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState(invoice?.currency ?? defaults.currency);
  const [jurisdiction, setJurisdiction] = useState(invoice?.jurisdiction ?? defaults.jurisdiction);
  const [treatment, setTreatment] = useState(invoice?.gstTreatment ?? 'auto');
  const [templateId, setTemplateId] = useState(invoice?.templateId ?? '');
  const [reference, setReference] = useState(invoice?.reference ?? '');
  const [notes, setNotes] = useState(invoice?.notes ?? '');
  const [terms, setTerms] = useState(invoice?.terms ?? defaults.terms);
  /**
   * When editing, the payment terms are whatever the stored due date actually
   * says — recomputing them from the default would silently move the due date
   * of an invoice the client has already been given.
   */
  const [termsDays, setTermsDays] = useState(
    String(
      invoice
        ? Math.max(
            Math.round(
              (Date.parse(`${invoice.dueOn}T00:00:00Z`) -
                Date.parse(`${invoice.issuedOn}T00:00:00Z`)) /
                86_400_000,
            ),
            0,
          )
        : defaults.paymentTermsDays,
    ),
  );
  const [fxRate, setFxRate] = useState(
    invoice && invoice.fxRateToResidence !== 1 ? String(invoice.fxRateToResidence) : '',
  );
  const [importedIds, setImportedIds] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>(
    invoice?.lines.length
      ? invoice.lines.map((l) => ({
          key: Math.random().toString(36).slice(2),
          description: l.description,
          quantity: String(l.quantity / 1000),
          unit: l.unit,
          unitPrice: String(l.unitPrice / 100),
          taxable: l.taxable,
        }))
      : [newLine()],
  );

  const client = clients.find((c) => c.id === clientId) ?? null;

  // Resolve the effective treatment the same way the server will, so the
  // preview does not disagree with the saved invoice.
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
    return { subtotal, gst, total: subtotal + gst, rate };
  }, [lines, effectiveTreatment, jurisdiction]);

  const dueOn = useMemo(() => {
    const date = new Date(`${issuedOn}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + (Number.parseInt(termsDays, 10) || 0));
    return date.toISOString().slice(0, 10);
  }, [issuedOn, termsDays]);

  const update = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const relevantUnbilled = unbilled.filter(
    (entry) => !importedIds.includes(entry.id) && (!clientId || entry.clientId === clientId),
  );

  const importTime = () => {
    const toImport = relevantUnbilled;
    if (toImport.length === 0) return;

    // One line per entry keeps the invoice legible and auditable against the
    // timesheet, rather than collapsing a week into a single opaque figure.
    const imported: Line[] = toImport.map((entry) => ({
      key: Math.random().toString(36).slice(2),
      description: entry.description || 'Design work',
      quantity: (entry.minutes / 60).toFixed(2),
      unit: 'hours',
      unitPrice: String((entry.hourlyRate ?? client?.hourlyRate ?? defaults.hourlyRate) / 100),
      taxable: true,
    }));

    setLines((current) => {
      const existing = current.filter((l) => l.description || l.unitPrice);
      return [...existing, ...imported];
    });
    setImportedIds((current) => [...current, ...toImport.map((e) => e.id)]);
  };

  const treatmentLabel: Record<string, string> = {
    standard: jurisdiction === 'NZ' ? 'GST 15%' : 'GST 10%',
    'zero-rated-export': jurisdiction === 'NZ' ? 'Zero-rated export (0%)' : 'GST-free export',
    exempt: 'Exempt',
    'not-registered': 'No GST — not registered',
  };

  return (
    <form method="post" action={invoice ? `/api/invoices/${invoice.id}` : '/api/invoices'} className="space-y-4">
      <input type="hidden" name="lines" value={JSON.stringify(
        lines
          .filter((l) => l.description.trim() || parseAmount(l.unitPrice) > 0)
          .map((l) => ({
            description: l.description,
            quantity: parseQuantity(l.quantity),
            unit: l.unit,
            unitPrice: parseAmount(l.unitPrice),
            taxable: l.taxable,
          })),
      )} />
      <input type="hidden" name="timeEntryIds" value={JSON.stringify(importedIds)} />
      <input type="hidden" name="dueOn" value={dueOn} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-3.5 p-4 sm:p-5 lg:col-span-2">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <div>
              <label htmlFor="clientId" className="label muted mb-1.5 block">Client</label>
              <select
                id="clientId"
                name="clientId"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  const next = clients.find((c) => c.id === e.target.value);
                  if (next) {
                    setCurrency(next.currency);
                    if (next.paymentTermsDays) setTermsDays(String(next.paymentTermsDays));
                  }
                }}
                className="field"
              >
                <option value="">No client (manual entry)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} · {c.country}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="reference" className="label muted mb-1.5 block">Reference</label>
              <input
                id="reference" name="reference" value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Project or PO number" className="field"
              />
            </div>

            {templates.length > 0 && (
              <div>
                <label htmlFor="templateId" className="label muted mb-1.5 block">Design</label>
                <select
                  id="templateId" name="templateId" value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)} className="field"
                >
                  {/* Empty means the account default, which is what an invoice
                      raised before templates existed already resolves to. */}
                  <option value="">
                    Default{defaultTemplateName ? ` (${defaultTemplateName})` : ''}
                  </option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="issuedOn" className="label muted mb-1.5 block">Issue date</label>
              <input
                id="issuedOn" name="issuedOn" type="date" value={issuedOn}
                onChange={(e) => setIssuedOn(e.target.value)} className="field"
              />
            </div>

            <div>
              <label htmlFor="termsDays" className="label muted mb-1.5 block">
                Payment terms
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="termsDays" type="number" min="0" value={termsDays}
                  onChange={(e) => setTermsDays(e.target.value)} className="field w-20"
                />
                <span className="muted text-sm">days · due {dueOn}</span>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="pt-1">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="label">Line items</h2>
              {relevantUnbilled.length > 0 && (
                <button
                  type="button" onClick={importTime}
                  className="btn btn-secondary btn-sm"
                >
                  Import {relevantUnbilled.length} unbilled entr{relevantUnbilled.length === 1 ? 'y' : 'ies'}
                </button>
              )}
            </div>

            <div className="space-y-2">
              {lines.map((line) => (
                <div
                  key={line.key}
                  className="grid grid-cols-12 items-start gap-2 border-b pb-3 last:border-b-0 last:pb-0 sm:border-b-0 sm:pb-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <input
                    value={line.description}
                    onChange={(e) => update(line.key, { description: e.target.value })}
                    placeholder="What was done"
                    className="field col-span-12 sm:col-span-5"
                    aria-label="Description"
                  />
                  <input
                    value={line.quantity}
                    onChange={(e) => update(line.key, { quantity: e.target.value })}
                    inputMode="decimal"
                    className="field col-span-4 sm:col-span-2"
                    aria-label="Quantity"
                  />
                  <select
                    value={line.unit}
                    onChange={(e) => update(line.key, { unit: e.target.value })}
                    className="field col-span-4 sm:col-span-1"
                    aria-label="Unit"
                  >
                    <option value="hours">hrs</option>
                    <option value="days">days</option>
                    <option value="fixed">fixed</option>
                    <option value="items">items</option>
                  </select>
                  <input
                    value={line.unitPrice}
                    onChange={(e) => update(line.key, { unitPrice: e.target.value })}
                    inputMode="decimal" placeholder="0.00"
                    className="field col-span-4 sm:col-span-2"
                    aria-label="Unit price"
                  />
                  <div className="col-span-12 flex items-center justify-end gap-2 sm:col-span-2 sm:pt-2">
                    <span className="tabular text-sm font-medium">
                      {money(
                        Math.round((parseQuantity(line.quantity) / 1000) * parseAmount(line.unitPrice)),
                        currency,
                      )}
                    </span>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
                        className="btn btn-ghost btn-sm px-2 text-base leading-none"
                        aria-label="Remove line"
                      >×</button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setLines((c) => [...c, newLine()])}
              className="btn btn-secondary btn-sm mt-2"
            >+ Add line</button>
          </div>

          <div className="grid gap-3.5 border-t pt-3.5 sm:grid-cols-2" style={{ borderColor: 'var(--border)' }}>
            <div>
              <label htmlFor="notes" className="label muted mb-1.5 block">Note to client</label>
              <textarea
                id="notes" name="notes" rows={2} value={notes}
                onChange={(e) => setNotes(e.target.value)} className="field"
              />
            </div>
            <div>
              <label htmlFor="terms" className="label muted mb-1.5 block">Terms</label>
              <textarea
                id="terms" name="terms" rows={2} value={terms}
                onChange={(e) => setTerms(e.target.value)} className="field"
              />
            </div>
          </div>
        </div>

        {/* Summary */}
        <div className="space-y-4">
          <div className="card p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-semibold">Totals</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="muted">Subtotal</dt>
                <dd className="tabular">{money(totals.subtotal, currency)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="muted">{treatmentLabel[effectiveTreatment]}</dt>
                <dd className="tabular">{money(totals.gst, currency)}</dd>
              </div>
              <div
                className="flex justify-between gap-3 border-t pt-2 text-base font-semibold"
                style={{ borderColor: 'var(--border)' }}
              >
                <dt>Total</dt>
                <dd className="tabular">{money(totals.total, currency)}</dd>
              </div>
            </dl>
          </div>

          <div className="card space-y-3.5 p-5">
            <h2 className="text-sm font-semibold">Tax treatment</h2>

            <div>
              <label htmlFor="jurisdiction" className="label muted mb-1.5 block">Jurisdiction</label>
              <select
                id="jurisdiction" name="jurisdiction" value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value as 'NZ' | 'AU')} className="field"
              >
                <option value="NZ">New Zealand</option>
                <option value="AU">Australia</option>
              </select>
            </div>

            <div>
              <label htmlFor="currency" className="label muted mb-1.5 block">Currency</label>
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
                <p className="muted mt-1 text-xs">
                  {fxRate.trim()
                    ? `${money(totals.total, currency)} counts as about ${money(
                        Math.round(totals.total * (Number.parseFloat(fxRate) || 0)),
                        defaults.residenceCurrency,
                      )} in your tax figures.`
                    : `Your tax figures are kept in ${defaults.residenceCurrency}. Without a rate this invoice is counted at face value, which overstates or understates your income by the whole spread. Use the rate on the issue date — that is the one the return uses.`}
                </p>
              </div>
            )}

            <div>
              <label htmlFor="gstTreatment" className="label muted mb-1.5 block">GST</label>
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

            {effectiveTreatment === 'zero-rated-export' && (
              <p className="muted text-xs leading-relaxed">
                No GST is charged because the client is offshore. Keep evidence of their
                location — a billing address alone is thin if you are ever asked.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="submit" name="action" value="draft"
              className="btn btn-secondary flex-1"
              style={{ borderColor: 'var(--border)' }}
            >Save draft</button>
            <button
              type="submit" name="action" value="finalise"
              className="btn btn-primary flex-1"
            >{invoice ? 'Save' : 'Create'}</button>
          </div>
        </div>
      </div>
    </form>
  );
}
