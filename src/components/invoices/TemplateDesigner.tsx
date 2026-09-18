import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_DESIGN,
  LAYOUTS,
  LAYOUT_DESCRIPTIONS,
  LAYOUT_LABELS,
  LOGO_POSITIONS,
  normalise,
  type InvoiceTemplateDesign,
  type LayoutId,
  type LogoPosition,
} from '~/lib/pdf/template';

/**
 * The invoice template designer.
 *
 * Controls on the left, the invoice on the right. The thing on the right is
 * not a mock-up: it is the actual PDF, rendered by the server with the same
 * function that renders the one a client is emailed, shown in an `<object>`.
 * Nothing here draws an approximation of an invoice in HTML — there is no
 * second renderer to drift out of step, and what you approve is byte for byte
 * what goes out.
 *
 * The cost of that honesty is a round trip per change, so edits are debounced
 * and the preview keeps showing the last good render while the next one is in
 * flight rather than blanking.
 */

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  design: string;
}

export interface TemplateDesignerProps {
  template: { id: string; name: string; description: string; isDefault: boolean };
  design: InvoiceTemplateDesign;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** The colours the designer exposes, in the order they are worth changing. */
const COLOUR_FIELDS: Array<{ key: keyof InvoiceTemplateDesign['theme']; label: string; hint: string }> = [
  { key: 'accent', label: 'Brand', hint: 'Headings, the amount due, and any filled area.' },
  { key: 'accentText', label: 'On brand', hint: 'Text sitting on top of the brand colour.' },
  { key: 'text', label: 'Text', hint: 'Body copy and figures.' },
  { key: 'muted', label: 'Secondary', hint: 'Labels, addresses and the footer.' },
  { key: 'background', label: 'Page', hint: 'The paper itself.' },
  { key: 'rule', label: 'Rules', hint: 'Hairlines between rows.' },
  { key: 'tableHeader', label: 'Table head', hint: 'The band behind the column titles.' },
];

const OPTION_FIELDS: Array<{ key: keyof InvoiceTemplateDesign['options']; label: string }> = [
  { key: 'showBusinessName', label: 'Show business name' },
  { key: 'showBankDetails', label: 'Show bank details' },
  { key: 'showPayLink', label: 'Show card payment link' },
  { key: 'stripeRows', label: 'Stripe alternate rows' },
  { key: 'highlightTotal', label: 'Highlight the amount due' },
];

export default function TemplateDesigner({ template, design: initial }: TemplateDesignerProps) {
  const [design, setDesign] = useState<InvoiceTemplateDesign>(() => normalise(initial));
  const [name, setName] = useState(template.name);
  const [isDefault, setIsDefault] = useState(template.isDefault);
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState('');

  // The rendered preview, as an object URL. Kept until the next one is ready.
  const [previewUrl, setPreviewUrl] = useState('');
  const [rendering, setRendering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  /** The URL currently held, so it can be revoked when replaced. */
  const heldUrl = useRef('');
  /** Bumped per request, so a slow render cannot overwrite a newer one. */
  const renderToken = useRef(0);

  const patch = useCallback((changes: Partial<InvoiceTemplateDesign>) => {
    setDesign((current) => normalise({ ...current, ...changes }));
  }, []);

  const patchTheme = useCallback(
    (key: keyof InvoiceTemplateDesign['theme'], value: string) => {
      setDesign((current) => normalise({ ...current, theme: { ...current.theme, [key]: value } }));
    },
    [],
  );

  const patchOption = useCallback(
    (key: keyof InvoiceTemplateDesign['options'], value: boolean) => {
      setDesign((current) => normalise({ ...current, options: { ...current.options, [key]: value } }));
    },
    [],
  );

  // ---- Preview -----------------------------------------------------------

  useEffect(() => {
    const token = ++renderToken.current;
    // Debounced: dragging a colour picker fires continuously, and each change
    // is a PDF render on the server.
    const timer = setTimeout(async () => {
      setRendering(true);
      try {
        const response = await fetch('/api/invoice-templates/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ design }),
        });
        if (!response.ok) throw new Error(await response.text());

        const blob = await response.blob();
        // A render that finished after a newer one started is discarded —
        // otherwise a slow request repaints the preview with a stale design.
        if (token !== renderToken.current) return;

        const url = URL.createObjectURL(blob);
        if (heldUrl.current) URL.revokeObjectURL(heldUrl.current);
        heldUrl.current = url;
        setPreviewUrl(url);
        setError('');
      } catch (cause) {
        if (token === renderToken.current) setError(`Preview failed: ${String(cause)}`);
      } finally {
        if (token === renderToken.current) setRendering(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [design]);

  // Revoke the last URL on unmount; nothing else holds a reference to it.
  useEffect(() => () => {
    if (heldUrl.current) URL.revokeObjectURL(heldUrl.current);
  }, []);

  // ---- Logo --------------------------------------------------------------

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError('');
      try {
        const body = new FormData();
        body.append('file', file);

        const response = await fetch('/api/invoice-templates/logo', { method: 'POST', body });
        const result = (await response.json()) as { key?: string; error?: string };

        if (!response.ok || !result.key) {
          setError(result.error ?? 'That logo could not be uploaded.');
          return;
        }
        setDesign((current) => normalise({ ...current, logo: { ...current.logo, key: result.key! } }));
      } catch (cause) {
        setError(`Upload failed: ${String(cause)}`);
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void upload(file);
    },
    [upload],
  );

  // ---- Saving ------------------------------------------------------------

  const store = useCallback(async () => {
    setSave('saving');
    try {
      const response = await fetch(`/api/invoice-templates/${template.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, design, isDefault }),
      });
      if (!response.ok) throw new Error(await response.text());
      setSave('saved');
      setTimeout(() => setSave('idle'), 2000);
    } catch (cause) {
      setSave('error');
      setError(`Could not save: ${String(cause)}`);
    }
  }, [design, isDefault, name, template.id]);

  const logoUrl = design.logo.key
    ? `/api/invoice-templates/asset/${design.logo.key.replace('invoice-assets/', '')}`
    : '';

  const saveLabel = useMemo(
    () => ({ idle: 'Save template', saving: 'Saving…', saved: 'Saved', error: 'Retry save' })[save],
    [save],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr] lg:items-start">
      {/* ---- Controls ---- */}
      <div className="flex flex-col gap-5">
        <section className="card p-4">
          <label className="label" htmlFor="template-name">Name</label>
          <input
            id="template-name"
            className="field mt-1"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.currentTarget.checked)}
            />
            <span>Use for new invoices</span>
          </label>
        </section>

        <section className="card p-4">
          <h2 className="label-xs">Layout</h2>
          <div className="mt-2 grid gap-2">
            {LAYOUTS.map((layout) => (
              <label
                key={layout}
                className={[
                  'flex cursor-pointer gap-3 rounded-lg border p-3 text-left',
                  design.layout === layout
                    ? 'border-[var(--accent)] bg-[var(--surface-2)]'
                    : 'border-[var(--line)]',
                ].filter(Boolean).join(' ')}
              >
                <input
                  type="radio"
                  name="layout"
                  className="mt-1"
                  checked={design.layout === layout}
                  onChange={() => patch({ layout })}
                />
                <span>
                  <span className="block text-sm font-medium">{LAYOUT_LABELS[layout]}</span>
                  <span className="muted block text-xs">{LAYOUT_DESCRIPTIONS[layout]}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* ---- Logo, by drag and drop ---- */}
        <section className="card p-4">
          <h2 className="label-xs">Logo</h2>

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click();
            }}
            className={[
              'mt-2 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center transition-colors',
              dragging ? 'border-[var(--accent)] bg-[var(--surface-2)]' : 'border-[var(--line)]',
            ].filter(Boolean).join(' ')}
          >
            {logoUrl ? (
              <img src={logoUrl} alt="" className="max-h-20 max-w-full object-contain" />
            ) : (
              <span className="muted text-sm">
                {uploading ? 'Uploading…' : 'Drop a PNG or JPEG here, or click to choose'}
              </span>
            )}
          </div>

          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void upload(file);
              event.currentTarget.value = '';
            }}
          />

          {design.logo.key && (
            <>
              <label className="label mt-3 block" htmlFor="logo-size">
                Size — {Math.round(design.logo.size)} pt
              </label>
              <input
                id="logo-size"
                type="range"
                min="24"
                max="220"
                className="w-full"
                value={design.logo.size}
                onChange={(event) =>
                  patch({ logo: { ...design.logo, size: Number(event.currentTarget.value) } })
                }
              />

              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="label">Position</span>
                <div className="flex gap-1">
                  {LOGO_POSITIONS.map((position) => (
                    <button
                      key={position}
                      type="button"
                      className={['seg', design.logo.position === position && 'seg-on'].filter(Boolean).join(' ')}
                      onClick={() => patch({ logo: { ...design.logo, position } })}
                    >
                      {position}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="btn btn-ghost btn-sm mt-3"
                onClick={() => patch({ logo: { ...design.logo, key: '' } })}
              >
                Remove logo
              </button>
            </>
          )}
        </section>

        {/* ---- Colours ---- */}
        <section className="card p-4">
          <h2 className="label-xs">Colours</h2>
          <div className="mt-2 grid gap-2">
            {COLOUR_FIELDS.map((field) => (
              <div key={field.key} className="flex items-center gap-3">
                <input
                  type="color"
                  aria-label={field.label}
                  className="h-8 w-10 shrink-0 cursor-pointer rounded border border-[var(--line)] bg-transparent"
                  value={design.theme[field.key]}
                  onChange={(event) => patchTheme(field.key, event.currentTarget.value)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{field.label}</span>
                  <span className="muted block text-xs">{field.hint}</span>
                </span>
                {/* The hex, typeable — a brand colour usually arrives as one. */}
                <input
                  className="field w-24 shrink-0 font-mono text-xs"
                  aria-label={`${field.label} hex`}
                  value={design.theme[field.key]}
                  onChange={(event) => patchTheme(field.key, event.currentTarget.value)}
                />
              </div>
            ))}
          </div>
        </section>

        <section className="card p-4">
          <h2 className="label-xs">Type &amp; content</h2>

          <label className="label mt-2 block" htmlFor="type-scale">
            Text size — {Math.round(design.typeScale * 100)}%
          </label>
          <input
            id="type-scale"
            type="range"
            min="80"
            max="125"
            className="w-full"
            value={Math.round(design.typeScale * 100)}
            onChange={(event) => patch({ typeScale: Number(event.currentTarget.value) / 100 })}
          />

          <div className="mt-3 grid gap-2">
            {OPTION_FIELDS.map((field) => (
              <label key={field.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={design.options[field.key]}
                  onChange={(event) => patchOption(field.key, event.currentTarget.checked)}
                />
                <span>{field.label}</span>
              </label>
            ))}
          </div>
        </section>

        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={() => void store()} disabled={save === 'saving'}>
            {saveLabel}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setDesign(normalise(DEFAULT_DESIGN))}
          >
            Reset
          </button>
        </div>

        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      </div>

      {/* ---- Preview ---- */}
      <div className="card overflow-hidden lg:sticky lg:top-4">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2">
          <span className="label-xs">Preview</span>
          <span className="muted text-xs">
            {rendering ? 'Rendering…' : 'The actual PDF, not a mock-up'}
          </span>
        </div>

        {previewUrl ? (
          <object
            data={previewUrl}
            type="application/pdf"
            className="h-[78vh] w-full bg-[var(--surface-2)]"
            aria-label="Invoice preview"
          >
            {/* Mobile browsers largely refuse to render a PDF inline. */}
            <p className="p-6 text-sm">
              Your browser will not display the PDF here.{' '}
              <a className="underline" href={previewUrl} target="_blank" rel="noreferrer">
                Open it in a new tab
              </a>
              .
            </p>
          </object>
        ) : (
          <div className="muted flex h-[78vh] items-center justify-center text-sm">
            Rendering the first preview…
          </div>
        )}
      </div>
    </div>
  );
}
