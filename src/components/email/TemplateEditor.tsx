import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmailEditor, type EmailEditorRef } from '@react-email/editor';
import '@react-email/editor/themes/default.css';
import '@react-email/editor/styles/bubble-menu.css';
import '@react-email/editor/styles/slash-command.css';
import '@react-email/editor/styles/inspector.css';

import { renderTemplate, unknownTokens } from '~/lib/mail/render';
import {
  KIND_LABELS,
  TEMPLATE_KINDS,
  VARIABLE_GROUPS,
  sampleValues,
  variablesFor,
  type TemplateKind,
} from '~/lib/mail/variables';

/**
 * The template editor.
 *
 * Mounted `client:only="react"` — this component and its Tiptap dependencies
 * must never reach the Worker bundle. The rendered email HTML is produced here
 * in the browser by `getEmail()` and posted to the server already finished, so
 * the Worker never runs React Email at all.
 *
 * Three representations are saved together: the Tiptap JSON (what this editor
 * reloads from), the HTML, and the plain-text alternative.
 */

export interface TemplateEditorProps {
  template: {
    id: string;
    name: string;
    kind: TemplateKind;
    subject: string;
    doc: string;
    isDefault: boolean;
  };
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** The Tiptap document, or undefined for a fresh template. */
function parseDoc(raw: string): object | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'type' in parsed) return parsed;
  } catch {
    // A corrupt document should open as an empty editor, not a blank screen.
  }
  return undefined;
}

export default function TemplateEditor({ template }: TemplateEditorProps) {
  const editorRef = useRef<EmailEditorRef>(null);

  const [name, setName] = useState(template.name);
  const [kind, setKind] = useState<TemplateKind>(template.kind);
  const [subject, setSubject] = useState(template.subject);
  const [isDefault, setIsDefault] = useState(template.isDefault);

  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  const [preview, setPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [missing, setMissing] = useState<string[]>([]);

  const initialContent = useMemo(() => parseDoc(template.doc), [template.doc]);
  const values = useMemo(() => sampleValues(kind), [kind]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSave('idle');
  }, []);

  /** Warn before losing unsaved work — this editor has no autosave. */
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const insertVariable = useCallback((key: string) => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    editor.chain().focus().insertContent(`{{${key}}}`).run();
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    const ref = editorRef.current;
    if (!ref) return;

    setSave('saving');
    setError(null);

    try {
      const { html, text } = await ref.getEmail();

      const response = await fetch(`/api/templates/${template.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          kind,
          subject,
          isDefault,
          doc: JSON.stringify(ref.getJSON()),
          html,
          text,
        }),
      });

      if (!response.ok) throw new Error(await response.text());

      // Surface typos now rather than as blanks in a client's inbox.
      setMissing(unknownTokens(`${subject}\n${html}`, values));
      setDirty(false);
      setSave('saved');
    } catch (cause) {
      setSave('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [template.id, name, kind, subject, isDefault, values]);

  /** Render with sample values, exactly as the send path will. */
  const showPreview = useCallback(async () => {
    const ref = editorRef.current;
    if (!ref) return;
    const html = await ref.getEmailHTML();
    setPreviewHtml(renderTemplate(html, values));
    setMissing(unknownTokens(`${subject}\n${html}`, values));
    setPreview(true);
  }, [subject, values]);

  const handleTestSend = useCallback(async () => {
    setTest('Sending…');
    try {
      // Save first — the server sends what is stored, not what is on screen.
      await handleSave();
      const response = await fetch(`/api/templates/${template.id}/test-send`, { method: 'POST' });
      const body = (await response.json()) as { ok?: boolean; to?: string; error?: string };
      setTest(response.ok ? `Sent to ${body.to}` : (body.error ?? 'Send failed.'));
    } catch (cause) {
      setTest(cause instanceof Error ? cause.message : String(cause));
    }
  }, [handleSave, template.id]);

  const uploadImage = useCallback(async (file: File) => {
    const body = new FormData();
    body.append('file', file);

    const response = await fetch('/api/uploads/email-image', { method: 'POST', body });
    const data = (await response.json()) as { url?: string; error?: string };

    if (!response.ok || !data.url) throw new Error(data.error ?? 'Upload failed.');
    return { url: data.url };
  }, []);

  const subjectPreview = renderTemplate(subject, values, { escape: false });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_17rem] lg:items-start">
      <div className="min-w-0 space-y-4">
        <div className="card space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <div>
              <label htmlFor="tpl-name" className="label-xs muted mb-1 block">
                Template name
              </label>
              <input
                id="tpl-name"
                className="field"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  markDirty();
                }}
              />
            </div>
            <div>
              <label htmlFor="tpl-kind" className="label-xs muted mb-1 block">
                Used for
              </label>
              <select
                id="tpl-kind"
                className="field"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as TemplateKind);
                  markDirty();
                }}
              >
                {TEMPLATE_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {KIND_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="tpl-subject" className="label-xs muted mb-1 block">
              Subject
            </label>
            <input
              id="tpl-subject"
              className="field"
              value={subject}
              placeholder="Invoice {{invoice.number}} from {{business.name}}"
              onChange={(event) => {
                setSubject(event.target.value);
                markDirty();
              }}
            />
            {subject.includes('{{') && (
              <p className="muted mt-1 truncate text-xs">Preview: {subjectPreview}</p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => {
                setIsDefault(event.target.checked);
                markDirty();
              }}
            />
            Pre-select this template when sending a {KIND_LABELS[kind].toLowerCase()}
          </label>
        </div>

        <div className="card overflow-hidden">
          <div
            className="flex items-center justify-between gap-2 border-b px-4 py-2"
            style={{ borderColor: 'var(--border)' }}
          >
            <span className="label-xs muted">{preview ? 'Preview' : 'Body'}</span>
            <div className="flex gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => (preview ? setPreview(false) : showPreview())}
              >
                {preview ? 'Back to editing' : 'Preview'}
              </button>
            </div>
          </div>

          {/* The editor stays mounted behind the preview so its document and
              undo history survive toggling back and forth. */}
          <div hidden={preview}>
            <EmailEditor
              ref={editorRef}
              content={initialContent}
              onUpdate={markDirty}
              onUploadImage={uploadImage}
              placeholder="Write the email. Press '/' for blocks, or insert a variable from the right."
              className="min-h-[26rem] p-4"
            />
          </div>

          {preview && (
            <iframe
              title="Email preview"
              // Sandboxed with no allow-scripts: this renders HTML the editor
              // produced, and it should never be able to run anything.
              sandbox=""
              srcDoc={previewHtml}
              className="min-h-[26rem] w-full border-0 bg-white"
            />
          )}
        </div>

        {missing.length > 0 && (
          <div className="card p-3 text-xs" style={{ borderColor: 'var(--border-strong)' }}>
            <p className="mb-1 font-medium">
              {missing.length === 1 ? 'This variable is' : 'These variables are'} not recognised and
              will send as blank space:
            </p>
            <p className="muted font-mono">{missing.map((key) => `{{${key}}}`).join('  ')}</p>
          </div>
        )}
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4">
        <div className="card space-y-2 p-4">
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={handleSave}
            disabled={save === 'saving'}
          >
            {save === 'saving' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
          <button
            type="button"
            className="btn btn-secondary w-full"
            onClick={handleTestSend}
            disabled={save === 'saving'}
          >
            Send test to myself
          </button>
          {save === 'saved' && !dirty && <p className="muted text-xs">Saved.</p>}
          {error && (
            <p className="text-xs" style={{ color: 'var(--danger, #b3261e)' }}>
              {error}
            </p>
          )}
          {test && <p className="muted text-xs">{test}</p>}
        </div>

        <div className="card p-4">
          <p className="label-xs muted mb-2">Variables</p>
          <p className="muted mb-3 text-xs leading-relaxed">
            Click to insert at the cursor. Each one is replaced with the real value when the email
            is sent.
          </p>

          <div className="space-y-3">
            {VARIABLE_GROUPS[kind].map((group) => (
              <div key={group.label}>
                <p className="label-xs muted mb-1">{group.label}</p>
                <div className="flex flex-wrap gap-1">
                  {group.variables.map((variable) => (
                    <button
                      key={variable.key}
                      type="button"
                      className="seg btn-sm"
                      title={`${variable.label} — e.g. ${variable.sample}`}
                      onClick={() => insertVariable(variable.key)}
                    >
                      {variable.key}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p className="muted mt-3 text-xs">
            {variablesFor(kind).length} available for {KIND_LABELS[kind].toLowerCase()} emails.
          </p>
        </div>
      </aside>
    </div>
  );
}
