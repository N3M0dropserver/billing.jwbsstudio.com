// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import TemplateEditor from '~/components/email/TemplateEditor';

/**
 * Does the builder actually come up?
 *
 * The three panes are wired together with portals into the editor's React
 * context — the layers tree and the inspector both render inside `EmailEditor`
 * and appear somewhere else in the DOM. That arrangement either works or
 * throws on mount, and a typecheck cannot tell which. Neither can it tell
 * whether the inspector found the theming extension it insists on.
 *
 * This is a smoke test and says so: it proves the thing mounts, renders its
 * chrome, and puts the editor on screen. It says nothing about how any of it
 * looks, which is still a job for eyes.
 */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(starterId?: string) {
  host = document.createElement('div');
  // `appendChild`, not `append`: this project's tsconfig loads
  // `@cloudflare/workers-types` globally for the Worker code, and its globals
  // shadow the DOM's `append` into something that wants a Response.
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <TemplateEditor
        starterId={starterId}
        template={{
          id: 'tpl_test',
          name: 'Test template',
          kind: 'invoice',
          subject: 'Invoice {{invoice.number}}',
          doc: '{}',
          isDefault: false,
        }}
      />,
    );
  });

  return host;
}

describe('the builder mounts', () => {
  it('renders all three panes', async () => {
    const el = await mount();

    expect(el.querySelector('.builder-canvas'), 'no canvas').not.toBeNull();
    expect(el.querySelector('.block-tile'), 'no block palette').not.toBeNull();
    // The editor itself, which only exists once Tiptap has a view.
    expect(el.querySelector('.ProseMirror'), 'no editor').not.toBeNull();
  });

  it('offers every palette block as something to pick up', async () => {
    const el = await mount();
    const tiles = [...el.querySelectorAll('.block-tile')];

    expect(tiles.length).toBeGreaterThan(8);
    // Image is the one tile with nothing to drag until a file is chosen.
    const draggable = tiles.filter((tile) => tile.getAttribute('draggable') === 'true');
    expect(tiles.length - draggable.length).toBe(1);
  });

  it('mounts the inspector into the right rail without complaint', async () => {
    // `Inspector.Root` throws outright if it cannot find the theming extension,
    // which is the kind of thing that only shows up at runtime.
    const el = await mount();
    expect(el.querySelector('[data-re-inspector-breadcrumb]'), 'no inspector').not.toBeNull();
  });

  it('opens a base template into the canvas', async () => {
    const el = await mount('statement');
    const text = el.querySelector('.ProseMirror')?.textContent ?? '';

    expect(text).toContain('{{invoice.amountDue}}');
    // Parsed as blocks rather than dropped in as text.
    expect(el.querySelector('.ProseMirror section'), 'starter lost its section').not.toBeNull();
  });

  it('lists the blocks of the open template in the layers tree', async () => {
    const el = await mount('statement');

    // The tree is portalled out of the editor and into the left rail.
    const rows = [...el.querySelectorAll('.layer-row')];
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.map((row) => row.textContent).join(' ')).toContain('Button');
  });
});
