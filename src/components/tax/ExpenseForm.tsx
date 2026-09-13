import { useState, useMemo } from 'react';
import { EXPENSE_GUIDANCE, type ExpenseCategory } from '~/lib/tax/deductions';
import type { ReceiptReading } from '~/lib/ai/receipt';

/**
 * Expense entry.
 *
 * The form does the teaching: picking a category surfaces the rule for that
 * category in both jurisdictions, pre-fills a sensible business-use split,
 * and — where the two countries disagree — says so before you claim
 * something you cannot.
 *
 * A photographed receipt fills it in. The reading is a proposal, never a
 * saved record: every figure lands in a field you can see and correct, and
 * anything the model could not make out is named rather than guessed.
 */

interface Props {
  clients: Array<{ id: string; name: string }>;
  defaultJurisdiction: 'NZ' | 'AU';
  gstRegistered: boolean;
  /** Currency the tax figures are kept in — follows tax residence. */
  residenceCurrency: 'NZD' | 'AUD';
}

/** What the upload control is doing, and what came back. */
type ReceiptState =
  | { status: 'idle'; key?: undefined; name?: undefined; error?: undefined; unreadable?: undefined }
  | { status: 'reading'; name: string; key?: undefined; error?: undefined; unreadable?: undefined }
  | { status: 'read'; name: string; key: string; unreadable: string[]; error?: undefined }
  | { status: 'stored'; name: string; key: string; error?: string; unreadable?: undefined }
  | { status: 'failed'; error: string; key?: undefined; name?: undefined; unreadable?: undefined };

const GST_RATES = { NZ: 0.15, AU: 0.10 };

const CAPITAL_THRESHOLDS = {
  NZ: { limit: 1_000, label: 'NZ$1,000' },
  AU: { limit: 20_000, label: 'AU$20,000' },
};

export default function ExpenseForm({
  clients,
  defaultJurisdiction,
  gstRegistered,
  residenceCurrency,
}: Props) {
  const [jurisdiction, setJurisdiction] = useState<'NZ' | 'AU'>(defaultJurisdiction);
  const [fxRate, setFxRate] = useState('');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [incurredOn, setIncurredOn] = useState(new Date().toISOString().slice(0, 10));
  const [receipt, setReceipt] = useState<ReceiptState>({ status: 'idle' });
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

  /**
   * Take the reading and fill the form in, leaving anything the model could
   * not make out alone rather than blanking what the user has already typed.
   */
  const applyReading = (reading: ReceiptReading) => {
    if (reading.description) setDescription(reading.description);
    else if (reading.vendor) setDescription(reading.vendor);
    if (reading.vendor) setVendor(reading.vendor);
    if (reading.incurredOn) setIncurredOn(reading.incurredOn);
    if (reading.amountGross !== null) setAmount((reading.amountGross / 100).toFixed(2));
    if (reading.currency) setJurisdiction(reading.currency === 'AUD' ? 'AU' : 'NZ');
    if (reading.category) applyCategory(reading.category);
    // A stated GST amount means the receipt is GST-inclusive.
    if (reading.gstAmount !== null && reading.gstAmount > 0) setHasGst(true);
  };

  const upload = async (file: File) => {
    setReceipt({ status: 'reading', name: file.name });

    const body = new FormData();
    body.append('receipt', file);

    try {
      const response = await fetch('/api/expenses/receipt', { method: 'POST', body });
      const data = (await response.json()) as {
        receiptKey?: string;
        read?: boolean;
        reading?: ReceiptReading;
        error?: string;
      };

      if (!response.ok || !data.receiptKey) {
        setReceipt({ status: 'failed', error: data.error ?? 'That upload did not work.' });
        return;
      }

      if (data.read && data.reading) {
        applyReading(data.reading);
        setReceipt({
          status: 'read',
          name: file.name,
          key: data.receiptKey,
          unreadable: data.reading.unreadable,
        });
      } else {
        // The image is stored either way — only the reading failed.
        setReceipt({
          status: 'stored',
          name: file.name,
          key: data.receiptKey,
          error: data.error,
        });
      }
    } catch (error) {
      setReceipt({ status: 'failed', error: String(error) });
    }
  };

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
      <div className="card space-y-3.5 p-5 lg:col-span-2">
        <div
          className="rounded-lg border border-dashed p-4"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-sunken)' }}
        >
          <label htmlFor="receiptFile" className="block text-sm font-medium">
            Photograph the receipt
          </label>
          <p className="muted mt-0.5 mb-2.5 text-xs">
            Optional, and it fills the form in for you. The image is kept with the expense —
            which is the record IRD and the ATO expect you to hold, whatever the figures say.
          </p>
          <input
            id="receiptFile" type="file" accept="image/*" capture="environment"
            className="block w-full text-xs"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {receipt.key && <input type="hidden" name="receiptKey" value={receipt.key} />}

          {receipt.status === 'reading' && (
            <p className="muted mt-2 text-xs" role="status">Reading {receipt.name}…</p>
          )}
          {receipt.status === 'read' && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-paid)' }} role="status">
              Read {receipt.name}. Check the figures below before saving
              {receipt.unreadable && receipt.unreadable.length > 0
                ? ` — the ${receipt.unreadable.join(' and ')} could not be made out.`
                : '.'}
            </p>
          )}
          {receipt.status === 'stored' && (
            <p className="muted mt-2 text-xs" role="status">
              {receipt.name} is saved with this expense, but could not be read
              {receipt.error ? `: ${receipt.error}` : '.'} Type the figures in below.
            </p>
          )}
          {receipt.status === 'failed' && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-overdue)' }} role="alert">
              {receipt.error}
            </p>
          )}
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="description" className="mb-1.5 block text-sm font-medium">
              What was it
            </label>
            <input
              id="description" name="description" required
              value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Adobe Creative Cloud annual subscription" className="field"
            />
          </div>

          <div>
            <label htmlFor="vendor" className="mb-1.5 block text-sm font-medium">Vendor</label>
            <input
              id="vendor" name="vendor" value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="Adobe" className="field"
            />
          </div>

          <div>
            <label htmlFor="incurredOn" className="mb-1.5 block text-sm font-medium">Date</label>
            <input
              id="incurredOn" name="incurredOn" type="date"
              value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)}
              className="field"
            />
          </div>

          <div>
            <label htmlFor="amount" className="mb-1.5 block text-sm font-medium">
              Amount {gstRegistered && <span className="muted font-normal">(as on the receipt)</span>}
            </label>
            <input
              id="amount" name="amount" value={amount} onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal" placeholder="0.00" required className="field"
            />
          </div>

          <div>
            <label htmlFor="category" className="mb-1.5 block text-sm font-medium">Category</label>
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
            <label htmlFor="jurisdiction" className="mb-1.5 block text-sm font-medium">Jurisdiction</label>
            <select
              id="jurisdiction" name="jurisdiction" value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value as 'NZ' | 'AU')} className="field"
            >
              <option value="NZ">New Zealand</option>
              <option value="AU">Australia</option>
            </select>
          </div>

          {(jurisdiction === 'NZ' ? 'NZD' : 'AUD') !== residenceCurrency && (
            <div>
              <label htmlFor="fxRateToResidence" className="mb-1.5 block text-sm font-medium">
                Rate to {residenceCurrency}
              </label>
              <input
                id="fxRateToResidence" name="fxRateToResidence" className="field tabular"
                inputMode="decimal" placeholder="1.0900"
                value={fxRate} onChange={(e) => setFxRate(e.target.value)}
              />
              <p className="muted mt-1 text-xs">
                Your tax figures are kept in {residenceCurrency}. Without a rate this is deducted
                at face value. Use the rate on the day you paid it.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="businessUsePercent" className="mb-1.5 block text-sm font-medium">
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
            <label htmlFor="clientId" className="mb-1.5 block text-sm font-medium">
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
                <label htmlFor="depreciationRate" className="muted mb-1 block text-xs font-medium">
                  Depreciation rate %
                </label>
                <input
                  id="depreciationRate" name="depreciationRate" type="number" min="0" max="100"
                  value={depreciationRate} onChange={(e) => setDepreciationRate(e.target.value)}
                  className="field"
                />
              </div>
              <div>
                <label htmlFor="depreciationMethod" className="muted mb-1 block text-xs font-medium">
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
          <label htmlFor="notes" className="mb-1.5 block text-sm font-medium">
            Notes <span className="muted font-normal">(what it was for)</span>
          </label>
          <textarea
            id="notes" name="notes" rows={2} className="field"
            placeholder="A line here is what turns a receipt into a defensible deduction three years from now."
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="card p-5">
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
              className="mt-3 rounded-md px-3 py-2 text-xs leading-relaxed"
              style={{ background: 'color-mix(in oklch, var(--color-owing) 12%, transparent)', color: 'var(--color-owing)' }}
            >
              This is over {threshold.label}. If it lasts beyond this year it is probably a
              capital asset and has to be depreciated, not deducted in one go.
            </p>
          )}
        </div>

        <div className="card p-5">
          <h2 className="mb-2 text-sm font-semibold">{guidance.label}</h2>
          <div className="muted space-y-2 text-xs leading-relaxed">
            <p><strong style={{ color: 'var(--text)' }}>NZ:</strong> {guidance.nz}</p>
            <p><strong style={{ color: 'var(--text)' }}>AU:</strong> {guidance.au}</p>
            {guidance.watchOut && (
              <p
                className="rounded-md px-2.5 py-2"
                style={{ background: 'color-mix(in oklch, var(--color-owing) 10%, transparent)' }}
              >
                <strong style={{ color: 'var(--color-owing)' }}>Watch out.</strong> {guidance.watchOut}
              </p>
            )}
          </div>
        </div>

        <button
          type="submit"
          className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white"
          style={{ background: 'var(--color-brand-600)' }}
        >Save expense</button>
      </div>
    </form>
  );
}
