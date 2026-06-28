import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RuntimeLogLine } from './RuntimeLogLine';
import type { RuntimeLogLine as RuntimeLogLineData } from '@/types/api';

// "Test logic not markup": the JSON↔raw branch, the level chip, and the
// collapse toggle — never Tailwind classes. The decode itself is covered in
// lib/runtimeLogs.test.ts.

function line(message: string, over: Partial<RuntimeLogLineData> = {}): RuntimeLogLineData {
  return { ts: '2026-06-28T16:10:22.014Z', message, stream: 'stdout', revision: null, ...over };
}

describe('RuntimeLogLine', () => {
  it('renders a plain-text line verbatim with no level chip or toggle', () => {
    render(<RuntimeLogLine line={line('Server listening on :3000')} />);
    expect(screen.getByText('Server listening on :3000')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('promotes the message of a structured JSON line and shows the level chip', () => {
    const json = JSON.stringify({
      level: 'info',
      message: 'GET /api/v1/manager/employees 304 26ms',
      service: 'expense-management-api',
    });
    render(<RuntimeLogLine line={line(json)} />);
    // The human message is shown, not the raw JSON blob.
    expect(screen.getByText('GET /api/v1/manager/employees 304 26ms')).toBeInTheDocument();
    expect(screen.queryByText(/"service":/)).not.toBeInTheDocument();
    expect(screen.getByText('info')).toBeInTheDocument();
  });

  it('hides the extra fields until the toggle is clicked, then reveals them', async () => {
    const user = userEvent.setup();
    const json = JSON.stringify({
      level: 'info',
      message: 'request done',
      service: 'expense-management-api',
      responseTime: 26,
    });
    render(<RuntimeLogLine line={line(json)} />);

    // Collapsed by default — field values are not in the DOM yet.
    expect(screen.queryByText('expense-management-api')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show .* log fields/i }));

    // Expanded — the leftover fields (key + value) are now visible.
    expect(screen.getByText('service')).toBeInTheDocument();
    expect(screen.getByText('expense-management-api')).toBeInTheDocument();
    expect(screen.getByText('responseTime')).toBeInTheDocument();
    expect(screen.getByText('26')).toBeInTheDocument();
  });

  it('renders a JSON object without a message field as raw text', () => {
    const json = '{"level":"info","service":"api","status":200}';
    render(<RuntimeLogLine line={line(json)} />);
    // No usable message → verbatim, no toggle.
    expect(screen.getByText(json)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
