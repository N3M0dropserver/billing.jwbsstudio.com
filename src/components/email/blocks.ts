/**
 * The block catalogue — what you can drag onto the canvas.
 *
 * Each block is a piece of HTML the editor parses back into a real node. That
 * choice buys three things: the same markup contract the base templates use
 * (see `starters.ts`), a drop that works at an arbitrary position rather than
 * only at the cursor, and a catalogue the schema test can parse and check.
 *
 * Image is the exception — there is nothing to insert until a file has been
 * chosen, so it carries an action instead of markup.
 */

import type { Editor } from '@tiptap/core';
import {
  BoxIcon,
  Columns2Icon,
  Columns3Icon,
  Heading1Icon,
  Heading2Icon,
  ImageIcon,
  LayoutIcon,
  ListIcon,
  ListOrderedIcon,
  MousePointerClickIcon,
  SplitSquareVerticalIcon,
  TextQuoteIcon,
  TypeIcon,
  type IconProps,
} from '@react-email/editor/ui';

// Type-only, emitting nothing: these modules declare `uploadImage` onto
// Tiptap's `Commands` interface, and without them the call below does not
// typecheck.
import type {} from '@react-email/editor/extensions';
import type {} from '@react-email/editor/plugins';

export interface Block {
  id: string;
  label: string;
  /** Shown on hover — what it is for, not what it is called. */
  hint: string;
  icon: (props: IconProps) => React.ReactElement;
  /**
   * The markup to insert. Deliberately unstyled: the editor theme dresses
   * these, and the inspector is where a block gets its own look. A palette
   * that inserted hard-coded colours would fight both.
   */
  content?: string;
  /** For blocks that cannot be expressed as markup — only Image, so far. */
  action?: (editor: Editor) => void;
}

export interface BlockGroup {
  label: string;
  blocks: Block[];
}

export const BLOCK_GROUPS: BlockGroup[] = [
  {
    label: 'Text',
    blocks: [
      {
        id: 'paragraph',
        label: 'Text',
        hint: 'A paragraph',
        icon: TypeIcon,
        content: '<p>Write something here.</p>',
      },
      {
        id: 'h1',
        label: 'Title',
        hint: 'Largest heading — one per email is plenty',
        icon: Heading1Icon,
        content: '<h1>Title</h1>',
      },
      {
        id: 'h2',
        label: 'Subtitle',
        hint: 'Second-level heading',
        icon: Heading2Icon,
        content: '<h2>Subtitle</h2>',
      },
      {
        id: 'bullets',
        label: 'Bullets',
        hint: 'Bulleted list',
        icon: ListIcon,
        content: '<ul><li><p>First thing</p></li><li><p>Second thing</p></li></ul>',
      },
      {
        id: 'numbers',
        label: 'Numbers',
        hint: 'Numbered list',
        icon: ListOrderedIcon,
        content: '<ol><li><p>First thing</p></li><li><p>Second thing</p></li></ol>',
      },
      {
        id: 'quote',
        label: 'Quote',
        hint: 'Indented quotation',
        icon: TextQuoteIcon,
        content: '<blockquote><p>Quoted text</p></blockquote>',
      },
    ],
  },
  {
    label: 'Layout',
    blocks: [
      {
        id: 'button',
        label: 'Button',
        hint: 'A link that looks like a button — set its address in the panel on the right',
        icon: MousePointerClickIcon,
        content: '<a data-id="react-email-button" href="#">Button</a>',
      },
      {
        id: 'divider',
        label: 'Divider',
        hint: 'Horizontal rule',
        icon: SplitSquareVerticalIcon,
        content: '<hr>',
      },
      {
        id: 'section',
        label: 'Section',
        hint: 'A band you can give its own background and padding',
        icon: LayoutIcon,
        content: '<section data-type="section"><p>Section</p></section>',
      },
      {
        id: 'columns-2',
        label: '2 columns',
        hint: 'Side-by-side columns — they stack on a phone',
        icon: Columns2Icon,
        content:
          '<div data-type="two-columns">' +
          '<div data-type="column"><p>Left</p></div>' +
          '<div data-type="column"><p>Right</p></div>' +
          '</div>',
      },
      {
        id: 'columns-3',
        label: '3 columns',
        hint: 'Three columns — they stack on a phone',
        icon: Columns3Icon,
        content:
          '<div data-type="three-columns">' +
          '<div data-type="column"><p>One</p></div>' +
          '<div data-type="column"><p>Two</p></div>' +
          '<div data-type="column"><p>Three</p></div>' +
          '</div>',
      },
      {
        id: 'image',
        label: 'Image',
        hint: 'Upload an image',
        icon: ImageIcon,
        // No markup: there is nothing to insert until a file is chosen. The
        // upload itself is `onUploadImage` on the editor.
        action: (editor) => {
          editor.commands.focus();
          editor.commands.uploadImage();
        },
      },
    ],
  },
];

export const BLOCKS: Block[] = BLOCK_GROUPS.flatMap((group) => group.blocks);

export function blockById(id: string | null | undefined): Block | null {
  if (!id) return null;
  return BLOCKS.find((block) => block.id === id) ?? null;
}

/** The icon for a node type in the document, for the layers tree. */
export const BOX_ICON = BoxIcon;
