import { useCallback, useEffect, useState } from 'react';
import { useCurrentEditor } from '@tiptap/react';

import { layersOf, selectBlock, selectedBlock, type Layer } from './targeting';

/**
 * The email as an outline.
 *
 * Two things a canvas cannot do on its own: show you a block that has scrolled
 * off, and let you select one you cannot put a cursor in. An empty section is
 * a few pixels of nothing on the canvas and an obvious row here.
 *
 * Reordering deliberately lives on the canvas toolbar instead of here. Two
 * places to drag the same block is two sets of drop rules to keep agreeing
 * with each other, and the canvas is where the consequence is visible.
 */

export default function LayersPanel() {
  const { editor } = useCurrentEditor();
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((count) => count + 1), []);

  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', bump);
    return () => {
      editor.off('transaction', bump);
    };
  }, [editor, bump]);

  if (!editor) return null;

  const layers = layersOf(editor);
  const selected = selectedBlock(editor)?.pos ?? null;

  if (layers.length === 0) {
    return <p className="muted text-xs leading-relaxed">Nothing yet. Drag a block onto the email.</p>;
  }

  const render = (items: Layer[], depth = 0) =>
    items.map((layer) => (
      <li key={layer.pos}>
        <button
          type="button"
          className={`layer-row ${selected === layer.pos ? 'layer-row-on' : ''}`}
          style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
          onClick={() => selectBlock(editor, layer.pos)}
        >
          <span className="layer-label">{layer.label}</span>
          {layer.excerpt && <span className="layer-excerpt">{layer.excerpt}</span>}
        </button>
        {layer.children.length > 0 && <ul>{render(layer.children, depth + 1)}</ul>}
      </li>
    ));

  return <ul className="layer-tree">{render(layers)}</ul>;
}
