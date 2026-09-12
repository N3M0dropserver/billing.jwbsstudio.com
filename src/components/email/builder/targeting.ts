/**
 * Finding blocks, and moving them about.
 *
 * The builder chrome — hover outline, selection toolbar, layers tree, drop
 * indicator — all needs the same two answers: which block is under this point,
 * and where is it on screen. ProseMirror can answer both, but not in one call
 * and not in terms a builder wants, so this is the translation layer.
 *
 * Everything here is a pure read of editor state or a single transaction. No
 * React, no DOM ownership — which is what lets the overlay stay a thin thing
 * that draws rectangles.
 */

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import { getNodeMeta } from '@react-email/editor/ui';

export interface BlockTarget {
  /** The position of the node itself, not of its content. */
  pos: number;
  end: number;
  type: string;
  node: PMNode;
}

/**
 * Structure rather than content.
 *
 * `container` is the width wrapper the editor maintains on its own and
 * `body` is the email itself — both are edited from the inspector's "Whole
 * email" panel, and neither is something you drag or delete. Selecting them
 * as blocks would offer a delete button for the document.
 */
const NOT_A_BLOCK = new Set(['doc', 'text', 'container', 'body', 'globalContent']);

function isBlockNode(node: PMNode | null | undefined): boolean {
  return Boolean(node && node.isBlock && !NOT_A_BLOCK.has(node.type.name));
}

function target(doc: PMNode, pos: number): BlockTarget | null {
  const node = doc.nodeAt(pos);
  if (!isBlockNode(node) || !node) return null;
  return { pos, end: pos + node.nodeSize, type: node.type.name, node };
}

/** The innermost block containing a document position. */
export function blockAt(editor: Editor, pos: number): BlockTarget | null {
  const { doc } = editor.state;
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (!isBlockNode(node)) continue;
    return { pos: $pos.before(depth), end: $pos.after(depth), type: node.type.name, node };
  }
  return null;
}

/**
 * The innermost block under a point on screen.
 *
 * `posAtCoords` reports both a document position and `inside` — the node the
 * point physically falls within. `inside` is the better answer for a leaf like
 * a divider or an image, where the nearest text position is beside the node
 * rather than in it, and it is equally right for a paragraph. Walking up from
 * `pos` is the fallback for the gaps between nodes.
 */
export function blockFromCoords(editor: Editor, x: number, y: number): BlockTarget | null {
  const found = editor.view.posAtCoords({ left: x, top: y });
  if (!found) return null;

  if (found.inside >= 0) {
    const inner = target(editor.state.doc, found.inside);
    if (inner) return inner;
  }
  return blockAt(editor, found.pos);
}

/** Where a block is on screen, in viewport coordinates. */
export function rectFor(editor: Editor, pos: number): DOMRect | null {
  let dom: Node | null;
  try {
    dom = editor.view.nodeDOM(pos);
  } catch {
    // The position can be stale for one render after a document change.
    return null;
  }

  const element = dom instanceof Element ? dom : (dom?.parentElement ?? null);
  return element ? element.getBoundingClientRect() : null;
}

/**
 * The block the editor considers current.
 *
 * A node selection names a block directly; a text cursor only implies one, and
 * the block it implies is the innermost one the caret sits in. Both need to
 * resolve to the same answer or the outline and the inspector disagree about
 * what is selected.
 */
export function selectedBlock(editor: Editor): BlockTarget | null {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection) {
    const direct = target(editor.state.doc, selection.from);
    if (direct) return direct;
  }
  return blockAt(editor, selection.from);
}

export function selectBlock(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;

  // A node selection is what the inspector reads, and it is what puts the
  // outline on the block rather than a blinking cursor inside it.
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  editor.view.focus();
}

/**
 * Select the block a transaction just put at `pos`, if one is there.
 *
 * `NodeSelection.create` throws when the position does not name a node, which
 * inside a dispatch would take the editor down with it. A drop at the very end
 * of a parent can land exactly there, so this is a guard rather than a
 * formality — and failing to move the selection is a far smaller problem than
 * throwing.
 */
function selectNodeAt(tr: Transaction, pos: number): void {
  if (tr.doc.nodeAt(pos)) tr.setSelection(NodeSelection.create(tr.doc, pos));
}

interface Siblings {
  index: number;
  parentStart: number;
  parent: PMNode;
  node: PMNode;
}

function siblingsOf(editor: Editor, pos: number): Siblings | null {
  const { doc } = editor.state;
  const node = doc.nodeAt(pos);
  if (!node) return null;

  const $pos = doc.resolve(pos);
  return { index: $pos.index(), parentStart: $pos.start(), parent: $pos.parent, node };
}

/**
 * Move a block past its neighbour.
 *
 * Delete-then-insert rather than a swap, because the two nodes are rarely the
 * same size and every position after the first edit has moved. Doing it in one
 * transaction keeps it a single undo step.
 */
export function moveBlock(editor: Editor, pos: number, direction: -1 | 1): boolean {
  const siblings = siblingsOf(editor, pos);
  if (!siblings) return false;

  const { index, parent, node } = siblings;
  const destination = index + direction;
  if (destination < 0 || destination >= parent.childCount) return false;

  const from = pos;
  const to = pos + node.nodeSize;
  const neighbour = parent.child(destination);

  // Moving up, everything before `from` is untouched by the delete. Moving
  // down, the neighbour slides back to where this node started.
  const insertAt = direction < 0 ? from - neighbour.nodeSize : from + neighbour.nodeSize;

  const tr = editor.state.tr.delete(from, to).insert(insertAt, node);
  selectNodeAt(tr, insertAt);
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

export function duplicateBlock(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;

  const at = pos + node.nodeSize;
  const tr = editor.state.tr.insert(at, node);
  selectNodeAt(tr, at);
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

export function removeBlock(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;

  editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
  editor.view.focus();
  return true;
}

/**
 * Move a block to a drop position.
 *
 * The insertion point is mapped through the deletion rather than adjusted by
 * hand: the drop may be anywhere in the document, including before the block
 * being moved, and `mapping` already knows which way everything shifted.
 */
export function moveBlockTo(editor: Editor, pos: number, insertAt: number): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return false;

  const to = pos + node.nodeSize;
  // Dropping a block into itself would delete it and insert it nowhere.
  if (insertAt >= pos && insertAt <= to) return false;

  const tr = editor.state.tr.delete(pos, to);
  const mapped = tr.mapping.map(insertAt);
  tr.insert(mapped, node);
  selectNodeAt(tr, mapped);
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

export function insertBlockAt(editor: Editor, insertAt: number, content: string): void {
  editor.chain().focus().insertContentAt(insertAt, content).run();
}

export interface Layer {
  pos: number;
  /** The position just after the block, which is where a drop below it goes. */
  end: number;
  type: string;
  label: string;
  /** The first few words, so two paragraphs are tellable apart. */
  excerpt: string;
  children: Layer[];
}

/**
 * The document as a tree of blocks.
 *
 * Descends through structural nodes rather than showing them, so the tree
 * reads as the email's outline — the wrapper the editor maintains is not
 * something anyone thinks of as part of their layout.
 */
export function layersOf(editor: Editor): Layer[] {
  const build = (node: PMNode, offset: number): Layer[] => {
    const layers: Layer[] = [];

    node.forEach((child, childOffset) => {
      const pos = offset + childOffset;
      if (!child.isBlock) return;

      if (NOT_A_BLOCK.has(child.type.name)) {
        layers.push(...build(child, pos + 1));
        return;
      }

      layers.push({
        pos,
        end: pos + child.nodeSize,
        type: child.type.name,
        label: getNodeMeta(child.type.name).label,
        excerpt: child.textContent.trim().slice(0, 40),
        // Text lives in paragraphs; listing their inline content as layers
        // would turn an outline into a transcript.
        children: child.isTextblock ? [] : build(child, pos + 1),
      });
    });

    return layers;
  };

  return build(editor.state.doc, 0);
}
