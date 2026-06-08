import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DemoBanner } from './DemoBanner';

// "Test logic not markup": assert the trigger condition (renders iff the
// session is a demo sandbox) and the message presence — never Tailwind classes.

const useCurrentUser = vi.fn();
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => useCurrentUser(),
}));

beforeEach(() => {
  useCurrentUser.mockReset();
});

describe('DemoBanner', () => {
  it('renders the sandbox notice when the session is a demo (isDemo: true)', () => {
    useCurrentUser.mockReturnValue({ data: { isDemo: true } });
    render(<DemoBanner />);

    const banner = screen.getByRole('status');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/demo sandbox/i)).toBeInTheDocument();
    expect(screen.getByText(/simulated and reset periodically/i)).toBeInTheDocument();
  });

  it('renders nothing for a real user (isDemo: false)', () => {
    useCurrentUser.mockReturnValue({ data: { isDemo: false } });
    render(<DemoBanner />);

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing when there is no current user yet (loading/unauthenticated)', () => {
    useCurrentUser.mockReturnValue({ data: undefined });
    render(<DemoBanner />);

    expect(screen.queryByRole('status')).toBeNull();
  });
});
