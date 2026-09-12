import { useCallback, useEffect, useState } from 'react';
import { useCurrentEditor } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { getNodeMeta } from '@react-email/editor/ui';

import {
  blockFromCoords,
  duplicateBlock,
  moveBlock,
  rectFor,
  removeBlock,
  selectBlock,
  selectedBlock,
} from './targeting';

/**
 * The builder chrome drawn over the canvas.
 *
 * Everything here is a rectangle on top of the editor, never a change to how
 * the editor works. The document underneath is still an ordinary rich-text
 * document — you can type in it, paste into it, undo through it. The outlines
 * and the toolbar are a reading of its state, which means there is no second
 * model to keep in sync and no way for the chrome to disagree with the email.
 *
 * The overlay itself never takes the pointer; only the two controls that need
 * clicks do. Anything else would put a sheet of glass over the text.
 */

export interface DropIndicator {
  top: number;
  left: number;
  width: number;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface OverlayProps {
  /** The positioned element the overlay draws inside. */
  canvas: HTMLElement | null;
  /** Where a drop would land, or null when nothing is being dragged. */
  indicator: DropIndicator | null;
  /** Raised when the selected block's handle starts a drag. */
  onMoveStart: (pos: number) => void;
  onMoveEnd: () => void;
}

export default function Overlay({ canvas, indicator, onMoveStart, onMoveEnd }: OverlayProps) {
  const { editor } = useCurrentEditor();

  const [hoverPos, setHoverPos] = useState<number | null>(null);
  /*
   * Rectangles are read from the DOM, so they go stale on anything that moves
   * them: a keystroke, a scroll, a window resize. Rather than tracking which
   * of those happened, the overlay re-reads on all of them. It is two
   * `getBoundingClientRect` calls — cheap enough to do often, and the
   * alternative is an outline that lags behind the block it is outlining.
   */
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((count) => count + 1), []);

  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', bump);
    // Focus is not always a transaction, and whether the editor has focus
    // decides whether the selection chrome is drawn at all.
    editor.on('focus', bump);
    editor.on('blur', bump);
    window.addEventListener('resize', bump);
    window.addEventListener('scroll', bump, true);
    return () => {
      editor.off('transaction', bump);
      editor.off('focus', bump);
      editor.off('blur', bump);
      window.removeEventListener('resize', bump);
      window.removeEventListener('scroll', bump, true);
    };
  }, [editor, bump]);

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;

    const onMove = (event: MouseEvent) => {
      const found = blockFromCoords(editor, event.clientX, event.clientY);
      setHoverPos(found?.pos ?? null);
    };
    const onLeave = () => setHoverPos(null);

    dom.addEventListener('mousemove', onMove);
    dom.addEventListener('mouseleave', onLeave);
    return () => {
      dom.removeEventListener('mousemove', onMove);
      dom.removeEventListener('mouseleave', onLeave);
    };
  }, [editor]);

  if (!editor || !canvas) return null;

  const frame = canvas.getBoundingClientRect();
  const boxAt = (pos: number): Box | null => {
    const rect = rectFor(editor, pos);
    if (!rect) return null;
    // Scroll offsets because the overlay is positioned against the canvas's
    // content box, while a client rect is measured against the window. They
    // are the same number until the canvas scrolls, and then they are not.
    return {
      top: rect.top - frame.top + canvas.scrollTop,
      left: rect.left - frame.left + canvas.scrollLeft,
      width: rect.width,
      height: rect.height,
    };
  };

  /*
   * An unfocused editor still has a cursor position — the start of the
   * document — and drawing a toolbar around whatever happens to be there means
   * the page loads with the first paragraph looking selected. Nothing is
   * selected until either the editor has focus or a block was chosen outright,
   * from the layers tree or a chip.
   */
  const active = editor.isFocused || editor.state.selection instanceof NodeSelection;
  const selection = active ? selectedBlock(editor) : null;
  const selectedBox = selection ? boxAt(selection.pos) : null;

  // One outline is enough: hovering the block you already have selected should
  // not draw a second rectangle a pixel outside the first.
  const hovered =
    hoverPos !== null && hoverPos !== selection?.pos
      ? {
          pos: hoverPos,
          box: boxAt(hoverPos),
          type: editor.state.doc.nodeAt(hoverPos)?.type.name,
        }
      : null;

  const act = (run: () => void) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  };

  return (
    <div className="builder-overlay" aria-hidden="true">
      {hovered?.box && (
        <div className="builder-hover" style={{ ...hovered.box, position: 'absolute' }}>
          {hovered.type && (
            <button
              type="button"
              className="builder-chip"
              // The one way to select a block you cannot put a cursor in —
              // a section, a column, the row holding them.
              onMouseDown={act(() => selectBlock(editor, hovered.pos))}
            >
              {getNodeMeta(hovered.type).label}
            </button>
          )}
        </div>
      )}

      {selection && selectedBox && (
        <div className="builder-selected" style={{ ...selectedBox, position: 'absolute' }}>
          <div className="builder-toolbar">
            <span className="builder-chip builder-chip-on">
              {getNodeMeta(selection.type).label}
            </span>
            <span
              className="builder-grip"
              draggable
              title="Drag to move"
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                // Firefox ignores a drag that carries no data at all.
                event.dataTransfer.setData('text/plain', '');
                onMoveStart(selection.pos);
              }}
              onDragEnd={onMoveEnd}
            >
              ⠿
            </span>
            <button
              type="button"
              title="Move up"
              onMouseDown={act(() => moveBlock(editor, selection.pos, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              title="Move down"
              onMouseDown={act(() => moveBlock(editor, selection.pos, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              title="Duplicate"
              onMouseDown={act(() => duplicateBlock(editor, selection.pos))}
            >
              ⧉
            </button>
            <button
              type="button"
              title="Delete"
              onMouseDown={act(() => removeBlock(editor, selection.pos))}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {indicator && (
        <div
          className="builder-drop"
          style={{
            position: 'absolute',
            top: indicator.top,
            left: indicator.left,
            width: indicator.width,
          }}
        />
      )}
    </div>
  );
}
