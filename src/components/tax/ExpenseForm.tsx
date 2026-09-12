import { useState, useMemo } from 'react';
import { EXPENSE_GUIDANCE, type ExpenseCategory } from '~/lib/tax/deductions';

/**
 * Expense entry.
 *
 * The form does the teaching: picking a category surfaces the rule for that
 * category in both jurisdictions, pre-fills a sensible business-use split,
 * and — where the two countries disagree — says so before you claim
 * something you cannot.
 */

interface Props {
  clients: Array<{ id: string; name: string }>;
  defaultJurisdiction: 'NZ' | 'AU';
  gstRegistered: boolean;
}

const GST_RATES = { NZ: 0.15, AU: 0.10 };

const CAPITAL_THRESHOLDS = {
  NZ: { limit: 1_000, label: 'NZ$1,000' },
  AU: { limit: 20_000, label: 'AU$20,000' },
};

export default function ExpenseForm({ clients, defaultJurisdiction, gstRegistered }: Props) {
  const [jurisdiction, setJurisdiction] = useState<'NZ' | 'AU'>(defaultJurisdiction);
  const [category, setCategory] = useState<ExpenseCategory>('software');
  const [amount, setAmount] = useState('');
  const [businessUse, setBusinessUse] = useState('100');
  const [hasGst, setHasGst] = useState(gstRegistered);
  const [isCapital, setIsCapital] = useState(false);
  const [depreciationRate, setDepreciationRate] = useState('30');

  const guidance = EXPENSE_GUIDANCE[category];
  const amountCents = useMemo(() => {
    const parsed = Number.parseFloat(amount.replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }, [amount]);

  const gstRate = GST_RATES[jurisdiction];
  const net = hasGst && gstRegistered ? Math.round(amountCents / (1 + gstRate)) : amountCents;
  const gst = amountCents - net;
  const usePercent = (Number.parseFloat(businessUse) || 0) / 100;
  const claimable = Math.round(net * usePercent);

  const threshold = CAPITAL_THRESHOLDS[jurisdiction];
  const looksCapital = net >= threshold.limit * 100;
  const writeOffAvailable = isCapital && net < threshold.limit * 100;

  const money = (cents: number) =>
    new Intl.NumberFormat('en-NZ', {
      style: 'currency',
      currency: jurisdiction === 'NZ' ? 'NZD' : 'AUD',
    }).format(cents / 100);

  const applyCategory = (next: ExpenseCategory) => {
    setCategory(next);
    const info = EXPENSE_GUIDANCE[next];
    if (info.defaultBusinessUse !== null) {
      setBusinessUse(String(Math.round(info.defaultBusinessUse * 100)));
    }
    setIsCapital(info.deductible === 'capital');
  };

  return (
    <form method="post" action="/api/expenses" className="grid gap-4 lg:grid-cols-3">
      <div className="card space-y-3.5 p-4 sm:p-5 lg:col-span-2">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="description" className="label muted mb-1.5 block">
              What was it
            </label>
            <input
              id="description" name="description" required
              placeholder="Adobe Creative Cloud annual subscription" className="field"
            />
          </div>

          <div>
            <label htmlFor="vendor" className="label muted mb-1.5 block">Vendor</label>
            <input id="vendor" name="vendor" placeholder="Adobe" className="field" />
          </div>

          <div>
            <label htmlFor="incurredOn" className="label muted mb-1.5 block">Date</label>
            <input
              id="incurredOn" name="incurredOn" type="date"
              defaultValue={new Date().toISOString().slice(0, 10)} className="field"
            />
          </div>

          <div>
            <label htmlFor="amount" className="label muted mb-1.5 block">
              Amount {gstRegistered && <span className="muted font-normal">(as on the receipt)</span>}
            </label>
            <input
              id="amount" name="amount" value={amount} onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal" placeholder="0.00" required className="field"
            />
          </div>

          <div>
            <label htmlFor="category" className="label muted mb-1.5 block">Category</label>
            <select
              id="category" name="category" value={category}
              onChange={(e) => applyCategory(e.target.value as ExpenseCategory)} className="field"
            >
              {Object.values(EXPENSE_GUIDANCE).map((item) => (
                <option key={item.category} value={item.category}>{item.label}</option>
              ))}
            </select>
          </div>

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
            <label htmlFor="businessUsePercent" className="label muted mb-1.5 block">
              Business use
            </label>
            <div className="flex items-center gap-2">
              <input
                id="businessUsePercent" name="businessUsePercent" type="number" min="0" max="100"
                value={businessUse} onChange={(e) => setBusinessUse(e.target.value)} className="field"
              />
              <span className="muted text-sm">%</span>
            </div>
          </div>

          <div>
            <label htmlFor="clientId" className="label muted mb-1.5 block">
              Client <span className="muted font-normal">(optional)</span>
            </label>
            <select id="clientId" name="clientId" className="field">
              <option value="">Not client-specific</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <div className="space-y-2.5 border-t pt-3.5" style={{ borderColor: 'var(--border)' }}>
          {gstRegistered && (
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox" name="hasGst" value="yes" checked={hasGst}
                onChange={(e) => setHasGst(e.target.checked)} className="mt-0.5"
              />
              <span>
                GST was charged on this
                <span className="muted block text-xs">
                  Untick for an overseas supplier, a bank fee, or anything else GST-free.
                </span>
              </span>
            </label>
          )}

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox" name="isCapital" value="yes" checked={isCapital}
              onChange={(e) => setIsCapital(e.target.checked)} className="mt-0.5"
            />
            <span>
              This is a capital asset
              <span className="muted block text-xs">
                Equipment that lasts beyond this year — depreciated rather than deducted at once.
              </span>
            </span>
          </label>

          {isCapital && (
            <div className="grid gap-3 pl-7 sm:grid-cols-2">
              <div>
                <label htmlFor="depreciationRate" className="label muted mb-1.5 block">
                  Depreciation rate %
                </label>
                <input
                  id="depreciationRate" name="depreciationRate" type="number" min="0" max="100"
                  value={depreciationRate} onChange={(e) => setDepreciationRate(e.target.value)}
                  className="field"
                />
              </div>
              <div>
                <label htmlFor="depreciationMethod" className="label muted mb-1.5 block">
                  Method
                </label>
                <select id="depreciationMethod" name="depreciationMethod" className="field">
                  <option value="DV">Diminishing value</option>
                  <option value="SL">Straight line</option>
                </select>
              </div>
            </div>
          )}

          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" name="isBillable" value="yes" className="mt-0.5" />
            <span>
              Rebill this to the client
              <span className="muted block text-xs">Flags it to add to their next invoice.</span>
            </span>
          </label>
        </div>

        <div>
          <label htmlFor="notes" className="label muted mb-1.5 block">
            Notes <span className="muted font-normal">(what it was for)</span>
          </label>
          <textarea
            id="notes" name="notes" rows={2} className="field"
            placeholder="A line here is what turns a receipt into a defensible deduction three years from now."
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="card p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold">What you can claim</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="muted">Amount paid</dt>
              <dd className="tabular">{money(amountCents)}</dd>
            </div>
            {hasGst && gstRegistered && (
              <div className="flex justify-between gap-3">
                <dt className="muted">GST reclaimable</dt>
                <dd className="tabular">{money(Math.round(gst * usePercent))}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="muted">Net of GST</dt>
              <dd className="tabular">{money(net)}</dd>
            </div>
            <div
              className="flex justify-between gap-3 border-t pt-2 font-semibold"
              style={{ borderColor: 'var(--border)' }}
            >
              <dt>{isCapital ? 'Depreciable base' : 'Deductible'}</dt>
              <dd className="tabular" style={{ color: 'var(--color-paid)' }}>{money(claimable)}</dd>
            </div>
          </dl>

          {isCapital && (
            <p className="muted mt-3 border-t pt-3 text-xs leading-relaxed" style={{ borderColor: 'var(--border)' }}>
              {writeOffAvailable
                ? `Under the ${threshold.label} threshold, so the whole business portion is deducted this year rather than depreciated.`
                : `Over the ${threshold.label} threshold, so this is depreciated at ${depreciationRate}% a year.`}
            </p>
          )}
          {!isCapital && looksCapital && (
            <p
              className="mt-3 px-3 py-2 text-xs leading-relaxed"
              style={{
                background: 'color-mix(in oklch, var(--color-owing) 12%, transparent)',
                color: 'var(--color-owing)',
                borderRadius: 'var(--radius-ctl)',
              }}
            >
              This is over {threshold.label}. If it lasts beyond this year it is probably a
              capital asset and has to be depreciated, not deducted in one go.
            </p>
          )}
        </div>

        <div className="card p-4 sm:p-5">
          <h2 className="label mb-2.5">{guidance.label}</h2>
          <div className="muted space-y-2 text-xs leading-relaxed">
            <p><strong style={{ color: 'var(--text)' }}>NZ:</strong> {guidance.nz}</p>
            <p><strong style={{ color: 'var(--text)' }}>AU:</strong> {guidance.au}</p>
            {guidance.watchOut && (
              <p
                className="px-2.5 py-2"
                style={{
                  background: 'color-mix(in oklch, var(--color-owing) 10%, transparent)',
                  borderRadius: 'var(--radius-ctl)',
                }}
              >
                <strong style={{ color: 'var(--color-owing)' }}>Watch out.</strong> {guidance.watchOut}
              </p>
            )}
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary w-full"
        >Save expense</button>
      </div>
    </form>
  );
}
