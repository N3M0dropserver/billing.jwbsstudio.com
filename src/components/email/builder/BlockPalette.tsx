import { BLOCK_GROUPS, type Block } from '../blocks';

/**
 * The blocks, as things you can pick up.
 *
 * Drag is the headline gesture, but click has to work too: drag does not exist
 * on a touch screen, and it is a poor fit for anyone using a keyboard or a
 * pointer they steer slowly. Both paths end in the same insert.
 */

export interface BlockPaletteProps {
  /** Click — insert at the cursor. */
  onInsert: (block: Block) => void;
  /** Drag — the drop decides where it lands. */
  onDragStart: (block: Block) => void;
  onDragEnd: () => void;
}

export default function BlockPalette({ onInsert, onDragStart, onDragEnd }: BlockPaletteProps) {
  return (
    <div className="space-y-4">
      {BLOCK_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="label-xs muted mb-2">{group.label}</p>
          <div className="grid grid-cols-2 gap-1.5">
            {group.blocks.map((block) => {
              const Icon = block.icon;
              return (
                <button
                  key={block.id}
                  type="button"
                  className="block-tile"
                  title={block.hint}
                  // An image has no markup until a file is chosen, so it has
                  // nothing to drag.
                  draggable={Boolean(block.content)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    // Firefox ignores a drag that carries no data at all.
                    event.dataTransfer.setData('text/plain', block.label);
                    onDragStart(block);
                  }}
                  onDragEnd={onDragEnd}
                  onClick={() => onInsert(block)}
                >
                  <Icon size={16} />
                  <span>{block.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
