import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, ClipboardPaste } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { EnvRow } from '@/lib/envVars';
import { Button } from './Button';
import { IconButton } from './IconButton';

export type { EnvRow } from '@/lib/envVars';

export interface KeyValueEditorProps {
  value: EnvRow[];
  onChange: (next: EnvRow[]) => void;
  disabled?: boolean;
}

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

const FIELD =
  'h-9 w-full rounded-lg border bg-slate-900 px-3 text-sm text-slate-100 placeholder:text-slate-500 ' +
  'transition-colors focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

/** Placeholder shown in the value field of an unedited stored secret. The
 * server never sends the cleartext (values are write-only), so an existing
 * secret can't be revealed — only replaced by typing a new value. The "(set)"
 * marks that a value is stored; "type to replace" signals it's still editable
 * (the masked field otherwise looks like the value was lost). */
const STORED_PLACEHOLDER = '•••••••• (set — type to replace)';

/**
 * Env-var rows editor. Keys are validated against the backend's
 * `^[A-Z_][A-Z0-9_]*$` rule with inline error styling. Values are write-only:
 * a row that came from the server shows a masked "(set)" placeholder and holds
 * no cleartext — the user replaces a value by typing a new one (no reveal of an
 * existing secret, by design). New/edited values are masked by default with a
 * per-row reveal toggle. "Paste .env" expands a textarea that parses
 * `KEY=VALUE` lines (ignoring blanks + `#` comments) and merges them in,
 * overwriting existing keys.
 */
export function KeyValueEditor({ value, onChange, disabled = false }: KeyValueEditorProps) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const updateRow = (index: number, patch: Partial<EnvRow>) => {
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  // Typing into the value field marks the row edited — that's the signal the
  // save logic uses to send a replacement value (vs. keeping the stored one).
  const setRowValue = (index: number, next: string) => {
    updateRow(index, { value: next, edited: true });
  };

  const removeRow = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    setRevealed((prev) => {
      const next = new Set<number>();
      for (const i of prev) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  };

  const addRow = () => onChange([...value, { key: '', value: '', stored: false, edited: false }]);

  const toggleReveal = (index: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const importEnv = () => {
    const parsed: { key: string; value: string }[] = [];
    for (const rawLine of pasteText.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      let val = line.slice(eq + 1).trim();
      // Strip a single layer of matching surrounding quotes.
      if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
        val = val.slice(1, -1);
      }
      if (key.length > 0) parsed.push({ key, value: val });
    }
    if (parsed.length > 0) {
      // Merge in place: overwrite an existing row with the same (non-empty) key,
      // otherwise append. A pasted value is always a real (edited) value.
      const next = [...value];
      for (const p of parsed) {
        const idx = next.findIndex((r) => r.key.length > 0 && r.key === p.key);
        if (idx >= 0) next[idx] = { ...next[idx]!, key: p.key, value: p.value, edited: true };
        else next.push({ key: p.key, value: p.value, stored: false, edited: true });
      }
      onChange(next);
    }
    setPasteText('');
    setPasteOpen(false);
  };

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 && !pasteOpen && (
        <p className="text-sm text-slate-500">
          No environment variables. Add one or paste a <code className="font-mono">.env</code>.
        </p>
      )}

      {value.length > 0 && (
        <div className="flex flex-col gap-2">
          {value.map((row, index) => {
            const keyInvalid = row.key.length > 0 && !isValidEnvKey(row.key);
            // An unedited stored row holds no cleartext — show the masked
            // "(set)" placeholder instead and don't let it be revealed.
            const isStoredMasked = row.stored && !row.edited;
            return (
              <div key={index} className="flex items-start gap-2">
                <div className="w-2/5">
                  <input
                    aria-label={`Variable ${index + 1} name`}
                    className={cn(FIELD, 'font-mono', keyInvalid ? 'border-rose-500/70' : 'border-slate-700')}
                    placeholder="KEY"
                    value={row.key}
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => updateRow(index, { key: e.target.value })}
                  />
                  {keyInvalid && (
                    <p className="mt-1 text-xs text-rose-400">Use A–Z, 0–9, _ (must not start with a digit).</p>
                  )}
                </div>
                <div className="relative flex-1">
                  <input
                    aria-label={`Variable ${index + 1} value`}
                    className={cn(FIELD, 'border-slate-700 pr-9 font-mono')}
                    placeholder={isStoredMasked ? STORED_PLACEHOLDER : 'value'}
                    // A stored-masked row has an empty value field with a "(set)"
                    // placeholder; it stays type=text so the placeholder reads as
                    // plain text. Edited/new values mask unless revealed.
                    type={isStoredMasked || revealed.has(index) ? 'text' : 'password'}
                    value={row.value}
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setRowValue(index, e.target.value)}
                  />
                  {!isStoredMasked && (
                    <button
                      type="button"
                      aria-label={revealed.has(index) ? 'Hide value' : 'Reveal value'}
                      onClick={() => toggleReveal(index)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-slate-500 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                    >
                      {revealed.has(index) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  )}
                </div>
                <IconButton
                  label={`Remove ${row.key || 'variable'}`}
                  size="md"
                  icon={<Trash2 />}
                  disabled={disabled}
                  onClick={() => removeRow(index)}
                />
              </div>
            );
          })}
        </div>
      )}

      {pasteOpen && (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Paste .env contents"
            className={cn(
              'min-h-24 w-full rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-xs text-slate-100',
              'focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40',
            )}
            placeholder={'KEY=value\nANOTHER_KEY=another value'}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={importEnv} disabled={pasteText.trim().length === 0}>
              Import
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPasteOpen(false);
                setPasteText('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!pasteOpen && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" leadingIcon={<Plus size={14} />} onClick={addRow} disabled={disabled}>
            Add variable
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<ClipboardPaste size={14} />}
            onClick={() => setPasteOpen(true)}
            disabled={disabled}
          >
            Paste .env
          </Button>
        </div>
      )}
    </div>
  );
}
