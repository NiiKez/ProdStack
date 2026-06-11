import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyValueEditor } from './KeyValueEditor';
import { rowsFromServer } from '@/lib/envVars';

// "Test logic not markup": these assert the editor's write-only behavior — that
// a stored secret renders masked with no cleartext, that it can't be revealed,
// and that typing marks the row edited so the save path sends a replacement.

describe('KeyValueEditor write-only behavior', () => {
  it('renders a stored secret masked with a "(set)" placeholder and no cleartext value', () => {
    const rows = rowsFromServer([{ key: 'API_KEY', hasValue: true }]);
    render(<KeyValueEditor value={rows} onChange={vi.fn()} />);

    const valueInput = screen.getByLabelText('Variable 1 value') as HTMLInputElement;
    // The cleartext is never present — the field is empty with a "(set)" hint
    // that also signals the value is still replaceable by typing.
    expect(valueInput.value).toBe('');
    expect(valueInput.placeholder).toContain('set');
    expect(valueInput.placeholder).toContain('type to replace');
  });

  it('does not offer a reveal toggle for an unedited stored secret', () => {
    const rows = rowsFromServer([{ key: 'API_KEY', hasValue: true }]);
    render(<KeyValueEditor value={rows} onChange={vi.fn()} />);

    // No reveal — an existing secret can't be shown (the server never sent it).
    expect(screen.queryByLabelText('Reveal value')).toBeNull();
    expect(screen.queryByLabelText('Hide value')).toBeNull();
  });

  it('marks the row edited (carrying the typed value) when the user types a replacement', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const rows = rowsFromServer([{ key: 'API_KEY', hasValue: true }]);
    render(<KeyValueEditor value={rows} onChange={onChange} />);

    await user.type(screen.getByLabelText('Variable 1 value'), 'x');

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0];
    expect(next[0]).toMatchObject({ key: 'API_KEY', value: 'x', stored: true, edited: true });
  });

  it('adds a brand-new row as stored:false (so the save sends its value)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KeyValueEditor value={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add variable/i }));

    expect(onChange).toHaveBeenCalledWith([
      { key: '', value: '', stored: false, edited: false },
    ]);
  });
});
