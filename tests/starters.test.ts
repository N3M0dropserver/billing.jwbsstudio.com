// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@react-email/editor/extensions';
import type { JSONContent } from '@tiptap/core';

import { STARTERS } from '~/lib/mail/starters';
import { BLOCKS } from '~/components/email/blocks';

/**
 * The base templates, run through the real editor schema.
 *
 * `templates.test.ts` checks the starters as text — the right variables, the
 * right tags. This checks the thing that actually matters: that the editor
 * turns that text into the blocks it was meant to be. A starter whose button
 * is missing one attribute still looks like valid HTML and still renders; it
 * just silently arrives as a paragraph, and nobody finds out until they open
 * the template and wonder where the button went.
 *
 * This is the only test that loads Tiptap, and it needs a DOM to parse HTML —
 * hence the environment comment above. Nothing here runs in the Worker.
 *
 * `@tiptap/core` and `happy-dom` are pinned to exact versions in package.json
 * rather than ranged. This test is only meaningful if it parses with the same
 * schema the editor ships; a `^` that drifted one of them out of step with
 * `@react-email/editor` would leave the test passing against a schema nothing
 * in the app actually uses.
 */

function parse(html: string): JSONContent {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure()],
    content: html,
  });
  const doc = editor.getJSON();
  editor.destroy();
  return doc;
}

/** Every node type in the document, flattened. */
function typesIn(node: JSONContent, found: string[] = []): string[] {
  if (node.type) found.push(node.type);
  for (const child of node.content ?? []) typesIn(child, found);
  return found;
}

function nodesOfType(node: JSONContent, type: string, found: JSONContent[] = []): JSONContent[] {
  if (node.type === type) found.push(node);
  for (const child of node.content ?? []) nodesOfType(child, type, found);
  return found;
}

/** All text in the document, as the editor would show it. */
function textIn(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textIn).join(' ');
}

const parsed = STARTERS.map((starter) => ({ starter, doc: parse(starter.html) }));

describe('base templates, parsed by the editor', () => {
  it.each(parsed)('$starter.id keeps every variable it was written with', ({ starter, doc }) => {
    // A token that survives to here survives to the send path. One that does
    // not was dropped by a block that failed to parse, taking its text along.
    const authored = [...starter.html.matchAll(/\{\{([a-zA-Z0-9_.-]+)\}\}/g)].map((m) => m[1]);
    const text = textIn(doc);

    for (const token of authored) {
      // Link targets live in an attribute, not in the text.
      if (token.startsWith('links.')) continue;
      expect(text, `${starter.id} lost {{${token}}} on parse`).toContain(`{{${token}}}`);
    }
  });

  it.each(parsed)('$starter.id produces no stray empty blocks', ({ doc }) => {
    // Paragraphs the parser invents around a block it did not understand.
    const emptyParagraphs = nodesOfType(doc, 'paragraph').filter(
      (node) => (node.content ?? []).length === 0,
    );
    // The editor appends one trailing paragraph on purpose, to give you
    // somewhere to type after the last block.
    expect(emptyParagraphs.length).toBeLessThanOrEqual(1);
  });

  it('parses buttons as buttons, with their link and styling intact', () => {
    for (const { starter, doc } of parsed) {
      for (const button of nodesOfType(doc, 'button')) {
        expect(button.attrs?.href, `${starter.id}: button lost its href`).toBeTruthy();
        expect(button.attrs?.style, `${starter.id}: button lost its styling`).toContain(
          'background-color',
        );
        expect(textIn(button).trim(), `${starter.id}: button has no label`).not.toBe('');
      }
    }
  });

  it('parses each block type as itself rather than as a paragraph', () => {
    // One assertion per starter that claims a block, so a regression names the
    // starter and the block rather than just failing somewhere.
    const expected: Record<string, string[]> = {
      plain: ['paragraph'],
      statement: ['heading', 'section', 'button', 'horizontalRule', 'twoColumns', 'columnsColumn'],
      nudge: ['paragraph', 'button'],
      overdue: ['heading', 'section', 'button', 'horizontalRule'],
      proposal: ['heading', 'section', 'button'],
      branded: ['section', 'horizontalRule', 'twoColumns', 'columnsColumn'],
    };

    for (const { starter, doc } of parsed) {
      const types = new Set(typesIn(doc));
      for (const type of expected[starter.id] ?? []) {
        expect(types.has(type), `${starter.id} has no ${type} block`).toBe(true);
      }
    }
  });

  it('gives every starter a container, so the email has a width', () => {
    // Without one the content runs the full width of the window in clients
    // that honour it. The editor enforces this, which is worth pinning down:
    // it is the difference between an email and a wall of text.
    for (const { starter, doc } of parsed) {
      expect(typesIn(doc), `${starter.id} has no container`).toContain('container');
    }
  });

  it('nests columns exactly two deep, never orphaning one', () => {
    for (const { starter, doc } of parsed) {
      for (const columns of nodesOfType(doc, 'twoColumns')) {
        expect(columns.content?.length, `${starter.id}: a two-column block lost a column`).toBe(2);
        for (const column of columns.content ?? []) {
          expect(column.type).toBe('columnsColumn');
        }
      }
    }
  });
});

describe('palette blocks, parsed by the editor', () => {
  /** What each tile must actually produce when dropped. */
  const PRODUCES: Record<string, string> = {
    paragraph: 'paragraph',
    h1: 'heading',
    h2: 'heading',
    bullets: 'bulletList',
    numbers: 'orderedList',
    quote: 'blockquote',
    button: 'button',
    divider: 'horizontalRule',
    section: 'section',
    'columns-2': 'twoColumns',
    'columns-3': 'threeColumns',
  };

  it('covers every block in the palette', () => {
    // A tile added without a line here would go untested, which is exactly the
    // tile most likely to have a typo in its markup.
    const draggable = BLOCKS.filter((block) => block.content).map((block) => block.id);
    expect(draggable.sort()).toEqual(Object.keys(PRODUCES).sort());
  });

  it('inserts the block each tile claims to insert', () => {
    for (const block of BLOCKS) {
      if (!block.content) continue;
      const types = typesIn(parse(block.content));
      expect(types, `the ${block.id} tile does not insert a ${PRODUCES[block.id]}`).toContain(
        PRODUCES[block.id],
      );
    }
  });

  it('gives Image an action rather than markup, and everything else markup', () => {
    // There is nothing to insert for an image until a file has been chosen.
    for (const block of BLOCKS) {
      expect(Boolean(block.content) !== Boolean(block.action), `${block.id} needs exactly one`).toBe(
        true,
      );
    }
    expect(BLOCKS.find((block) => block.action)?.id).toBe('image');
  });

  it('leaves the palette unstyled, so the theme and inspector own the look', () => {
    // A tile that carried its own colours would fight both the email theme and
    // any change made in the Design panel afterwards.
    for (const block of BLOCKS) {
      expect(block.content ?? '', `${block.id} carries hard-coded styling`).not.toContain('style=');
    }
  });
});
