/** A note for the kitchen on one dish ("no onion"); it goes with the dish's next KOT. */
import { LIMITS } from '@rb/shared';
import { MessageSquareText, Plus } from 'lucide-react';
import { useState } from 'react';

/**
 * Tap to write; saved when the box is left or Enter is pressed (typing does not save every
 * letter). `disabled`: the note shows but cannot change – e.g. the dish is all in the kitchen.
 */
export function DishNote({ note, onChange, disabled, dish }: { note: string; onChange: (note: string) => void; disabled?: boolean; dish: string }) {
  const [text, setText] = useState<string | null>(null);
  const done = () => {
    if (text !== null && text.trim() !== note) onChange(text.trim());
    setText(null);
  };
  if (text !== null) {
    return (
      <input
        className="input dish-note-input"
        autoFocus
        value={text}
        maxLength={LIMITS.maxDishNote}
        placeholder="e.g. no onion, less spicy"
        aria-label={`Note for ${dish}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setText(null);
        }}
      />
    );
  }
  if (!note && disabled) return null;
  return (
    <button
      type="button"
      className={note ? 'dish-note' : 'dish-note add'}
      onClick={() => setText(note)}
      disabled={disabled}
      title={note || undefined}
      aria-label={note ? `Note for ${dish}: ${note}` : `Add a note for ${dish}`}
    >
      {note ? <MessageSquareText size={13} /> : <Plus size={13} />}
      <span className="dish-note-text">{note || 'Note'}</span>
    </button>
  );
}
