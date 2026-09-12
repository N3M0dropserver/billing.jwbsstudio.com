import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EmailEditor, type EmailEditorRef } from '@react-email/editor';
import { Inspector } from '@react-email/editor/ui';
import { isDocumentVisuallyEmpty } from '@react-email/editor/core';
import '@react-email/editor/themes/default.css';
import '@react-email/editor/styles/bubble-menu.css';
import '@react-email/editor/styles/slash-command.css';
import '@react-email/editor/styles/inspector.css';

import { renderTemplate, unknownTokens } from '~/lib/mail/render';
import { starterById, startersFor, type Starter } from '~/lib/mail/starters';
import {
  KIND_LABELS,
  TEMPLATE_KINDS,
  VARIABLE_GROUPS,
  sampleValues,
  variablesFor,
  type TemplateKind,
} from '~/lib/mail/variables';
import { BLOCK_GROUPS } from './blocks';

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
 *
 * Three ways in to the same document, because they suit different moments:
 * a base template for starting, the block palette for building, and the
 * inspector for adjusting what is already there.
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
  /**
   * The base template chosen on the way in, for a template that has no body
   * yet. Carried as an id in the URL rather than written to the database at
   * creation, because turning starter HTML into the stored editor JSON needs
   * the editor schema — which only exists in the browser.
   */
  starterId?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
/** What the body card is showing. The editor stays mounted behind all three. */
type View = 'edit' | 'preview' | 'starters';
type Rail = 'design' | 'variables';

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

export default function TemplateEditor({ template, starterId }: TemplateEditorProps) {
  const editorRef = useRef<EmailEditorRef>(null);

  const [name, setName] = useState(template.name);
  const [kind, setKind] = useState<TemplateKind>(template.kind);
  const [subject, setSubject] = useState(template.subject);
  const [isDefault, setIsDefault] = useState(template.isDefault);

  const saved = useMemo(() => parseDoc(template.doc), [template.doc]);
  const opensWithStarter = !saved && Boolean(starterById(starterId));

  const [dirty, setDirty] = useState(opensWithStarter);
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);

  const [view, setView] = useState<View>('edit');
  const [rail, setRail] = useState<Rail>('variables');
  const [previewHtml, setPreviewHtml] = useState('');
  const [missing, setMissing] = useState<string[]>([]);

  /**
   * The inspector must live inside the editor's React context to read the
   * selection, but belongs on screen in the right-hand rail. A portal is the
   * one arrangement that gives both: it stays a child of `EmailEditor` in the
   * React tree and renders into the rail in the DOM.
   */
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null);

  const initialContent = useMemo(
    () => saved ?? starterById(starterId)?.html,
    [saved, starterId],
  );
  const values = useMemo(() => sampleValues(kind), [kind]);
  const starters = useMemo(() => startersFor(kind), [kind]);

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

  const insertBlock = useCallback((insert: (editor: NonNullable<EmailEditorRef['editor']>) => void) => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    insert(editor);
  }, []);

  /**
   * Swap the body for a base template.
   *
   * Destructive, so it asks — unless there is nothing to destroy. The subject
   * is only filled in when empty: someone who has written their own subject
   * and then goes looking for a nicer layout should not lose it.
   */
  const applyStarter = useCallback(
    (starter: Starter) => {
      const editor = editorRef.current?.editor;
      if (!editor) return;

      const occupied = !isDocumentVisuallyEmpty(editor.state.doc);
      if (
        occupied &&
        !window.confirm(`Replace the body with “${starter.name}”? What is there now will be lost.`)
      ) {
        return;
      }

      editor.chain().focus().setContent(starter.html).run();
      if (!subject.trim()) setSubject(starter.subject);
      setView('edit');
      markDirty();
    },
    [subject, markDirty],
  );

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
    setView('preview');
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
    <div className="email-editor grid gap-4 lg:grid-cols-[1fr_19rem] lg:items-start">
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
            <span className="label-xs muted">
              {view === 'preview' ? 'Preview' : view === 'starters' ? 'Base templates' : 'Body'}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setView(view === 'starters' ? 'edit' : 'starters')}
              >
                {view === 'starters' ? 'Back to editing' : 'Start from a base'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => (view === 'preview' ? setView('edit') : showPreview())}
              >
                {view === 'preview' ? 'Back to editing' : 'Preview'}
              </button>
            </div>
          </div>

          {/* The block palette. The same commands as typing '/', on a surface
              you can see without being told it exists. */}
          {view === 'edit' && (
            <div
              className="flex flex-wrap items-center gap-1 border-b px-3 py-2"
              style={{ borderColor: 'var(--border)' }}
            >
              {BLOCK_GROUPS.map((group, index) => (
                <Fragment key={group.label}>
                  {index > 0 && (
                    <span
                      aria-hidden="true"
                      className="mx-1 h-5 w-px"
                      style={{ background: 'var(--border)' }}
                    />
                  )}
                  {group.blocks.map((block) => (
                    <button
                      key={block.id}
                      type="button"
                      className="seg btn-sm"
                      title={block.hint}
                      onClick={() => insertBlock(block.insert)}
                    >
                      {block.label}
                    </button>
                  ))}
                </Fragment>
              ))}
            </div>
          )}

          {/* The editor stays mounted behind the other views so its document
              and undo history survive toggling back and forth. */}
          <div hidden={view !== 'edit'}>
            <EmailEditor
              ref={editorRef}
              content={initialContent}
              onUpdate={markDirty}
              onUploadImage={uploadImage}
              placeholder="Write the email. Press '/' for blocks, or use the palette above."
              className="min-h-[26rem] p-4"
            >
              {inspectorHost &&
                createPortal(
                  <Inspector.Root className="re-inspector space-y-3">
                    <Inspector.Breadcrumb />
                    <Inspector.Node />
                    <Inspector.Text />
                    <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                      <p className="label-xs muted mb-2">Whole email</p>
                      <Inspector.Document />
                    </div>
                  </Inspector.Root>,
                  inspectorHost,
                )}
            </EmailEditor>
          </div>

          {view === 'starters' && (
            <div className="p-4">
              <p className="muted mb-3 max-w-prose text-xs leading-relaxed">
                A finished layout to edit down, rather than a blank page. Picking one replaces the
                body — the variables in it are already the right ones for a{' '}
                {KIND_LABELS[kind].toLowerCase()} email.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {starters.map((starter) => (
                  <button
                    key={starter.id}
                    type="button"
                    className="card p-3 text-left"
                    style={{ borderColor: 'var(--border)' }}
                    onClick={() => applyStarter(starter)}
                  >
                    <span className="block text-sm font-medium">{starter.name}</span>
                    <span className="muted mt-1 block text-xs leading-relaxed">
                      {starter.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {view === 'preview' && (
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

        <div className="card overflow-hidden">
          <div
            className="flex gap-1 border-b p-2"
            style={{ borderColor: 'var(--border)' }}
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={rail === 'variables'}
              className={`seg btn-sm flex-1 ${rail === 'variables' ? 'seg-on' : ''}`}
              onClick={() => setRail('variables')}
            >
              Variables
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rail === 'design'}
              className={`seg btn-sm flex-1 ${rail === 'design' ? 'seg-on' : ''}`}
              onClick={() => setRail('design')}
            >
              Design
            </button>
          </div>

          <div className="p-4" hidden={rail !== 'variables'}>
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

          <div className="p-4" hidden={rail !== 'design'}>
            <p className="muted mb-3 text-xs leading-relaxed">
              Click a block in the email to change its spacing, colour and size. Settings for the
              whole email are at the bottom.
            </p>
            {/* Filled by the portal above, which is what puts the inspector
                inside the editor's context while it sits out here. */}
            <div ref={setInspectorHost} />
          </div>
        </div>
      </aside>
    </div>
  );
}
