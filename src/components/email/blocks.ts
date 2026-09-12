/**
 * The insertable blocks, as a visible palette.
 *
 * The editor already understands these — typing `/` brings up the same list.
 * But `/` is knowledge you either have or do not, and a template is edited
 * rarely enough that nobody remembers it between visits. The palette is the
 * same commands with a surface you can see, which costs a row of buttons and
 * removes the only thing about this editor you would otherwise have to be told.
 *
 * Each entry is the command the matching slash item runs, minus the
 * `deleteRange` that slash needs to clear the typed `/`.
 */

import type { Editor } from '@tiptap/core';

// Type-only, emitting nothing: these modules declare the `setButton`,
// `insertSection`, `insertColumns` and `uploadImage` commands onto Tiptap's
// `Commands` interface, and without them the chains below do not typecheck.
import type {} from '@react-email/editor/extensions';
import type {} from '@react-email/editor/plugins';

export interface Block {
  id: string;
  label: string;
  /** Shown on hover — what it is for, not what it is called. */
  hint: string;
  insert: (editor: Editor) => void;
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
        hint: 'Plain paragraph',
        insert: (editor) => editor.chain().focus().toggleNode('paragraph', 'paragraph').run(),
      },
      {
        id: 'h1',
        label: 'Title',
        hint: 'Largest heading — one per email is plenty',
        insert: (editor) => editor.chain().focus().setNode('heading', { level: 1 }).run(),
      },
      {
        id: 'h2',
        label: 'Subtitle',
        hint: 'Second-level heading',
        insert: (editor) => editor.chain().focus().setNode('heading', { level: 2 }).run(),
      },
      {
        id: 'bullets',
        label: 'Bullets',
        hint: 'Bulleted list',
        insert: (editor) => editor.chain().focus().toggleBulletList().run(),
      },
      {
        id: 'numbers',
        label: 'Numbers',
        hint: 'Numbered list',
        insert: (editor) => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        id: 'quote',
        label: 'Quote',
        hint: 'Indented quotation',
        insert: (editor) =>
          editor.chain().focus().toggleNode('paragraph', 'paragraph').toggleBlockquote().run(),
      },
    ],
  },
  {
    label: 'Blocks',
    blocks: [
      {
        id: 'button',
        label: 'Button',
        hint: 'A link that looks like a button — set its address by clicking it',
        insert: (editor) => editor.chain().focus().setButton().run(),
      },
      {
        id: 'section',
        label: 'Section',
        hint: 'A band you can give its own background and padding',
        insert: (editor) => editor.chain().focus().insertSection().run(),
      },
      {
        id: 'divider',
        label: 'Divider',
        hint: 'Horizontal rule',
        insert: (editor) => editor.chain().focus().setHorizontalRule().run(),
      },
      {
        id: 'columns-2',
        label: '2 columns',
        hint: 'Side-by-side columns — they stack on a phone',
        insert: (editor) => editor.chain().focus().insertColumns(2).run(),
      },
      {
        id: 'columns-3',
        label: '3 columns',
        hint: 'Three columns — they stack on a phone',
        insert: (editor) => editor.chain().focus().insertColumns(3).run(),
      },
      {
        id: 'image',
        label: 'Image',
        hint: 'Upload an image',
        // Opens the file picker; the upload itself is `onUploadImage` on the
        // editor, which posts to the image endpoint.
        insert: (editor) => {
          editor.commands.focus();
          editor.commands.uploadImage();
        },
      },
    ],
  },
];
