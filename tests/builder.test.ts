// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@react-email/editor/extensions';

import {
  blockAt,
  duplicateBlock,
  insertBlockAt,
  layersOf,
  moveBlock,
  moveBlockTo,
  removeBlock,
  selectBlock,
  selectedBlock,
} from '~/components/email/builder/targeting';

/**
 * The builder's position arithmetic.
 *
 * Every one of these functions turns a click into a document position and then
 * edits around it, which is the part of a block editor that quietly goes wrong:
 * a node's position is not its index, sibling positions shift the moment you
 * delete one, and nothing throws when you get it wrong — the block just lands
 * somewhere nobody asked for.
 *
 * So these run against a real editor with the real schema rather than a mock.
 * Needs a DOM, hence the environment comment; nothing here runs in the Worker.
 */

function editorWith(html: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure()],
    content: html,
  });
}

/**
 * The top-level blocks, minus the empty paragraph the editor keeps at the end.
 *
 * `TrailingNode` appends one after any block you cannot type into, so there is
 * always somewhere to put the cursor. It is a real node and it is correct that
 * it is there — it is just not part of the layout anyone designed, so these
 * tests would rather talk about the blocks than about it.
 */
function blocks(editor: Editor) {
  const layers = layersOf(editor);
  const last = layers.at(-1);
  const trailing = last?.type === 'paragraph' && last.excerpt === '';
  return trailing ? layers.slice(0, -1) : layers;
}

/** The top-level blocks, in order, by their text. */
function order(editor: Editor): string[] {
  return blocks(editor).map((layer) => layer.excerpt);
}

const THREE = '<p>One</p><p>Two</p><p>Three</p>';

describe('layersOf', () => {
  it('reads the document as an outline, skipping the wrapper', () => {
    const editor = editorWith(THREE);
    // The editor maintains a container around everything; it is structure, not
    // a block anyone thinks of as part of their layout.
    expect(layersOf(editor).map((layer) => layer.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    editor.destroy();
  });

  it('nests what is nested', () => {
    const editor = editorWith('<section data-type="section"><p>Inside</p></section>');
    const [section] = layersOf(editor);

    expect(section.type).toBe('section');
    expect(section.children.map((child) => child.type)).toEqual(['paragraph']);
    editor.destroy();
  });

  it('does not descend into text blocks', () => {
    // A paragraph's inline content is not an outline, it is a transcript.
    const editor = editorWith('<p>Some <strong>bold</strong> text</p>');
    expect(layersOf(editor)[0].children).toEqual([]);
    editor.destroy();
  });
});

describe('blockAt', () => {
  it('finds the paragraph a position sits inside', () => {
    const editor = editorWith(THREE);
    const second = layersOf(editor)[1];

    // A position one step into the node is inside its text.
    const found = blockAt(editor, second.pos + 1);
    expect(found?.pos).toBe(second.pos);
    expect(found?.type).toBe('paragraph');
    editor.destroy();
  });

  it('reports a block and not the wrapper that holds it', () => {
    const editor = editorWith('<section data-type="section"><p>Inside</p></section>');
    const paragraph = layersOf(editor)[0].children[0];

    expect(blockAt(editor, paragraph.pos + 1)?.type).toBe('paragraph');
    editor.destroy();
  });
});

describe('moveBlock', () => {
  it('moves a block past the one after it', () => {
    const editor = editorWith(THREE);
    expect(moveBlock(editor, layersOf(editor)[0].pos, 1)).toBe(true);
    expect(order(editor)).toEqual(['Two', 'One', 'Three']);
    editor.destroy();
  });

  it('moves a block past the one before it', () => {
    const editor = editorWith(THREE);
    expect(moveBlock(editor, layersOf(editor)[2].pos, -1)).toBe(true);
    expect(order(editor)).toEqual(['One', 'Three', 'Two']);
    editor.destroy();
  });

  it('comes back to where it started', () => {
    // The two directions have different arithmetic — down has to account for
    // the neighbour sliding back into the gap, up does not. This is the test
    // that catches one of them being wrong.
    const editor = editorWith(THREE);
    const start = order(editor);

    moveBlock(editor, layersOf(editor)[0].pos, 1);
    moveBlock(editor, layersOf(editor)[1].pos, -1);

    expect(order(editor)).toEqual(start);
    editor.destroy();
  });

  it('survives blocks of different sizes', () => {
    // Sibling positions are spaced by node size, not by one. A section with
    // three paragraphs in it is much wider than the paragraph beside it.
    const editor = editorWith(
      '<p>First</p><section data-type="section"><p>A</p><p>B</p><p>C</p></section><p>Last</p>',
    );

    moveBlock(editor, layersOf(editor)[2].pos, -1);
    expect(blocks(editor).map((layer) => layer.type)).toEqual([
      'paragraph',
      'paragraph',
      'section',
    ]);
    // The section kept its contents rather than being flattened by the move.
    expect(blocks(editor)[2].children).toHaveLength(3);
    editor.destroy();
  });

  it('refuses to move past either end', () => {
    const editor = editorWith(THREE);
    const layers = layersOf(editor);

    expect(moveBlock(editor, layers[0].pos, -1)).toBe(false);
    expect(moveBlock(editor, layers[2].pos, 1)).toBe(false);
    expect(order(editor)).toEqual(['One', 'Two', 'Three']);
    editor.destroy();
  });

  it('leaves the moved block selected', () => {
    const editor = editorWith(THREE);
    moveBlock(editor, layersOf(editor)[0].pos, 1);

    expect(selectedBlock(editor)?.node.textContent).toBe('One');
    editor.destroy();
  });
});

describe('duplicateBlock', () => {
  it('puts the copy directly after the original', () => {
    const editor = editorWith(THREE);
    duplicateBlock(editor, layersOf(editor)[1].pos);

    expect(order(editor)).toEqual(['One', 'Two', 'Two', 'Three']);
    editor.destroy();
  });

  it('copies the contents of a block, not just its shell', () => {
    const editor = editorWith('<section data-type="section"><p>A</p><p>B</p></section>');
    duplicateBlock(editor, layersOf(editor)[0].pos);

    const layers = blocks(editor);
    expect(layers).toHaveLength(2);
    expect(layers[1].children.map((child) => child.excerpt)).toEqual(['A', 'B']);
    editor.destroy();
  });
});

describe('removeBlock', () => {
  it('removes the block and nothing else', () => {
    const editor = editorWith(THREE);
    removeBlock(editor, layersOf(editor)[1].pos);

    expect(order(editor)).toEqual(['One', 'Three']);
    editor.destroy();
  });
});

describe('moveBlockTo', () => {
  it('moves a block forwards to a drop position', () => {
    const editor = editorWith(THREE);
    const layers = layersOf(editor);

    // Drop "One" after "Three".
    expect(moveBlockTo(editor, layers[0].pos, layers[2].end)).toBe(true);
    expect(order(editor)).toEqual(['Two', 'Three', 'One']);
    editor.destroy();
  });

  it('moves a block backwards to a drop position', () => {
    const editor = editorWith(THREE);
    const layers = layersOf(editor);

    expect(moveBlockTo(editor, layers[2].pos, layers[0].pos)).toBe(true);
    expect(order(editor)).toEqual(['Three', 'One', 'Two']);
    editor.destroy();
  });

  it('refuses to drop a block inside itself', () => {
    // Otherwise the delete removes it and the insert has nowhere to go.
    const editor = editorWith(THREE);
    const second = layersOf(editor)[1];

    expect(moveBlockTo(editor, second.pos, second.pos + 1)).toBe(false);
    expect(order(editor)).toEqual(['One', 'Two', 'Three']);
    editor.destroy();
  });

  it('drops a block into a section', () => {
    const editor = editorWith('<p>Loose</p><section data-type="section"><p>Inside</p></section>');
    const [loose, section] = layersOf(editor);

    moveBlockTo(editor, loose.pos, section.children[0].pos);

    const layers = blocks(editor);
    expect(layers).toHaveLength(1);
    expect(layers[0].children.map((child) => child.excerpt)).toEqual(['Loose', 'Inside']);
    editor.destroy();
  });
});

describe('insertBlockAt', () => {
  it('inserts markup at a position rather than at the cursor', () => {
    const editor = editorWith(THREE);
    const layers = layersOf(editor);

    insertBlockAt(editor, layers[1].pos, '<p>New</p>');
    expect(order(editor)).toEqual(['One', 'New', 'Two', 'Three']);
    editor.destroy();
  });

  it('inserts a real block, not a paragraph of markup', () => {
    const editor = editorWith(THREE);
    insertBlockAt(editor, layersOf(editor)[0].pos, '<hr>');

    expect(layersOf(editor)[0].type).toBe('horizontalRule');
    editor.destroy();
  });
});

describe('selectBlock', () => {
  it('selects the block itself, so the inspector edits the block', () => {
    const editor = editorWith('<section data-type="section"><p>Inside</p></section>');
    const section = layersOf(editor)[0];

    selectBlock(editor, section.pos);
    expect(selectedBlock(editor)?.type).toBe('section');
    editor.destroy();
  });
});
