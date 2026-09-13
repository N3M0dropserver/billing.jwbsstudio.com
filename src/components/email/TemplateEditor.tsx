import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { blockById, type Block } from './blocks';
import BlockPalette from './builder/BlockPalette';
import LayersPanel from './builder/LayersPanel';
import Overlay, { type DropIndicator } from './builder/Overlay';
import { blockFromCoords, insertBlockAt, moveBlockTo, rectFor } from './builder/targeting';

/**
 * The template builder.
 *
 * Three panes: blocks on the left, the email in the middle, settings for
 * whatever is selected on the right. The middle is a real rich-text editor —
 * click into it and type — and everything around it is chrome that reads the
 * same document. There is no second model of the email anywhere in here, which
 * is the whole reason the builder and the text editing can coexist rather than
 * fight: a block dragged in and a paragraph typed by hand produce the same
 * kind of node.
 *
 * Mounted `client:only="react"` — this component and its Tiptap dependencies
 * must never reach the Worker bundle. The rendered email HTML is produced here
 * in the browser by `getEmail()` and posted to the server already finished, so
 * the Worker never runs React Email at all.
 *
 * Three representations are saved together: the Tiptap JSON (what this builder
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
  /**
   * The base template chosen on the way in, for a template that has no body
   * yet. Carried as an id in the URL rather than written to the database at
   * creation, because turning starter HTML into the stored editor JSON needs
   * the editor schema — which only exists in the browser.
   */
  starterId?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
/** What the middle pane is showing. The editor stays mounted behind all three. */
type View = 'edit' | 'preview' | 'starters';
type LeftTab = 'blocks' | 'layers';
type RightTab = 'design' | 'variables';
type Device = 'desktop' | 'mobile';

/** What is being dragged, if anything. */
type Drag = { kind: 'block'; block: Block } | { kind: 'move'; pos: number };

/** A drop indicator, plus the document position it stands for. */
type Drop = DropIndicator & { pos: number };

/** Roughly the width a desktop client gives an email, and a mid-size phone. */
const DEVICE_WIDTH: Record<Device, number> = { desktop: 640, mobile: 380 };

/** The Tiptap document, or undefined for a fresh template. */
function parseDoc(raw: string): object | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'type' in parsed) return parsed;
  } catch {
    // A corrupt document should open as an empty builder, not a blank screen.
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
  const [leftTab, setLeftTab] = useState<LeftTab>('blocks');
  const [rightTab, setRightTab] = useState<RightTab>('design');
  const [device, setDevice] = useState<Device>('desktop');
  const [previewHtml, setPreviewHtml] = useState('');
  const [missing, setMissing] = useState<string[]>([]);

  /*
   * The layers tree and the inspector both need the editor's context to read
   * the document, and both belong in a rail on the far side of the screen. A
   * portal is the one arrangement that gives both: they stay children of
   * `EmailEditor` in the React tree and render into a rail in the DOM.
   */
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null);
  const [layersHost, setLayersHost] = useState<HTMLDivElement | null>(null);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);

  /*
   * Drag state is a ref as well as state: the drop handler needs the current
   * value at the moment of the drop, and a handler attached during a render
   * would otherwise read whatever was true when that render happened.
   */
  const dragRef = useRef<Drag | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const initialContent = useMemo(() => saved ?? starterById(starterId)?.html, [saved, starterId]);
  const values = useMemo(() => sampleValues(kind), [kind]);
  const starters = useMemo(() => startersFor(kind), [kind]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSave('idle');
  }, []);

  /** Warn before losing unsaved work — this builder has no autosave. */
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  // ---------------------------------------------------------------- dragging

  const clearDrag = useCallback(() => {
    dragRef.current = null;
    dropRef.current = null;
    setDrop(null);
  }, []);

  /**
   * Where a drop would land, from a point on screen.
   *
   * The answer is always relative to a block: above the one you are pointing
   * at, or below it, depending on which half of it the pointer is in. That
   * one rule covers dropping between two paragraphs and dropping inside an
   * empty section, because in both cases the block under the pointer is the
   * block you meant.
   */
  const dropAt = useCallback(
    (clientX: number, clientY: number): Drop | null => {
      const editor = editorRef.current?.editor;
      if (!editor || !canvas) return null;

      const target = blockFromCoords(editor, clientX, clientY);
      if (!target) return null;

      const rect = rectFor(editor, target.pos);
      if (!rect) return null;

      const frame = canvas.getBoundingClientRect();
      const below = clientY > rect.top + rect.height / 2;

      return {
        pos: below ? target.end : target.pos,
        top: (below ? rect.bottom : rect.top) - frame.top + canvas.scrollTop,
        left: rect.left - frame.left + canvas.scrollLeft,
        width: rect.width,
      };
    },
    [canvas],
  );

  /*
   * Capture phase, and the event stops here.
   *
   * ProseMirror has its own drop handling on the element underneath, and it is
   * good at what it does — but it would read a palette tile as dropped text.
   * Taking the event in the capture phase means it never gets there.
   */
  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!dragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = dragRef.current.kind === 'move' ? 'move' : 'copy';

      const next = dropAt(event.clientX, event.clientY);
      dropRef.current = next;
      setDrop(next);
    },
    [dropAt],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const drag = dragRef.current;
      const at = dropRef.current;
      if (!drag) return;

      event.preventDefault();
      event.stopPropagation();

      const editor = editorRef.current?.editor;
      clearDrag();
      if (!editor || !at) return;

      if (drag.kind === 'move') moveBlockTo(editor, drag.pos, at.pos);
      else if (drag.block.content) insertBlockAt(editor, at.pos, drag.block.content);
    },
    [clearDrag],
  );

  const insertBlock = useCallback((block: Block) => {
    const editor = editorRef.current?.editor;
    if (!editor) return;

    if (block.action) block.action(editor);
    else if (block.content) editor.chain().focus().insertContent(block.content).run();
  }, []);

  // ------------------------------------------------------------------ actions

  const run = useCallback((command: (editor: NonNullable<EmailEditorRef['editor']>) => void) => {
    const editor = editorRef.current?.editor;
    if (editor) command(editor);
  }, []);

  const insertVariable = useCallback((key: string) => {
    const editor = editorRef.current?.editor;
    if (!editor) return;
    editor.chain().focus().insertContent(`{{${key}}}`).run();
    setDirty(true);
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
    <div className="email-builder space-y-3">
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

      <div className="grid gap-3 xl:grid-cols-[13.5rem_minmax(0,1fr)_19rem] xl:items-start">
        {/* ------------------------------------------------------- left rail */}
        <aside className="card overflow-hidden xl:sticky xl:top-4">
          <div className="flex gap-1 border-b p-2" style={{ borderColor: 'var(--border)' }}>
            <button
              type="button"
              className={`seg btn-sm flex-1 ${leftTab === 'blocks' ? 'seg-on' : ''}`}
              onClick={() => setLeftTab('blocks')}
            >
              Blocks
            </button>
            <button
              type="button"
              className={`seg btn-sm flex-1 ${leftTab === 'layers' ? 'seg-on' : ''}`}
              onClick={() => setLeftTab('layers')}
            >
              Layers
            </button>
          </div>

          <div className="p-3" hidden={leftTab !== 'blocks'}>
            <BlockPalette
              onInsert={insertBlock}
              onDragStart={(block) => {
                dragRef.current = { kind: 'block', block };
              }}
              onDragEnd={clearDrag}
            />
            <p className="muted mt-4 text-xs leading-relaxed">
              Drag onto the email, or click to drop one in at the cursor. Typing{' '}
              <span className="font-mono">/</span> in the email does the same.
            </p>
          </div>

          {/* Filled by the portal below, which is what puts the tree inside the
              editor's context while it sits out here. */}
          <div className="p-3" hidden={leftTab !== 'layers'} ref={setLayersHost} />
        </aside>

        {/* ----------------------------------------------------------- canvas */}
        <div className="card overflow-hidden">
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title="Undo"
                onClick={() => run((editor) => editor.commands.undo())}
              >
                Undo
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title="Redo"
                onClick={() => run((editor) => editor.commands.redo())}
              >
                Redo
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`seg btn-sm ${device === 'desktop' ? 'seg-on' : ''}`}
                onClick={() => setDevice('desktop')}
              >
                Desktop
              </button>
              <button
                type="button"
                className={`seg btn-sm ${device === 'mobile' ? 'seg-on' : ''}`}
                onClick={() => setDevice('mobile')}
              >
                Mobile
              </button>
            </div>

            <div className="flex items-center gap-1">
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

          <div
            className="builder-canvas"
            ref={setCanvas}
            onDragOverCapture={onDragOver}
            onDropCapture={onDrop}
            onDragLeaveCapture={(event) => {
              // Leaving for a child element is not leaving the canvas.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
            }}
          >
            {/* The editor stays mounted behind the other views so its document
                and undo history survive toggling back and forth. */}
            <div
              className="builder-sheet"
              style={{ maxWidth: DEVICE_WIDTH[device] }}
              hidden={view !== 'edit'}
            >
              <EmailEditor
                ref={editorRef}
                content={initialContent}
                onUpdate={markDirty}
                onUploadImage={uploadImage}
                placeholder="Write the email, or drag a block in from the left."
                className="builder-content"
              >
                <Overlay
                  canvas={view === 'edit' ? canvas : null}
                  indicator={drop}
                  onMoveStart={(pos) => {
                    dragRef.current = { kind: 'move', pos };
                  }}
                  onMoveEnd={clearDrag}
                />

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

                {layersHost && createPortal(<LayersPanel />, layersHost)}
              </EmailEditor>
            </div>

            {view === 'starters' && (
              <div className="builder-panel">
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
                className="builder-sheet min-h-[30rem] w-full border-0 bg-white"
                style={{ maxWidth: DEVICE_WIDTH[device] }}
              />
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ right rail */}
        <aside className="space-y-3 xl:sticky xl:top-4">
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
            <div className="flex gap-1 border-b p-2" style={{ borderColor: 'var(--border)' }}>
              <button
                type="button"
                className={`seg btn-sm flex-1 ${rightTab === 'design' ? 'seg-on' : ''}`}
                onClick={() => setRightTab('design')}
              >
                Design
              </button>
              <button
                type="button"
                className={`seg btn-sm flex-1 ${rightTab === 'variables' ? 'seg-on' : ''}`}
                onClick={() => setRightTab('variables')}
              >
                Variables
              </button>
            </div>

            <div className="p-4" hidden={rightTab !== 'design'}>
              <p className="muted mb-3 text-xs leading-relaxed">
                Click a block on the canvas to change its spacing, colour and size. Settings for
                the whole email are at the bottom.
              </p>
              <div ref={setInspectorHost} />
            </div>

            <div className="p-4" hidden={rightTab !== 'variables'}>
              <p className="muted mb-3 text-xs leading-relaxed">
                Click to insert at the cursor. Each one is replaced with the real value when the
                email is sent.
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
          </div>
        </aside>
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
  );
}
