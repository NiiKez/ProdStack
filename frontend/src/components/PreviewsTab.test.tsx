import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { PreviewsTab } from './PreviewsTab';
import type { PreviewStatus, PreviewSummary, ProjectDetail } from '@/types/api';

// "Test logic not markup": assert the status→label mapping, the empty &
// disabled states, and that Tear down drives the teardown mutation — never CSS.

const usePreviewsMock = vi.fn();
const teardownMutate = vi.fn().mockResolvedValue({});
const useTeardownPreviewMock = vi.fn(() => ({ mutateAsync: teardownMutate, isPending: false }));

vi.mock('@/hooks/usePreviews', () => ({
  usePreviews: () => usePreviewsMock(),
  useTeardownPreview: () => useTeardownPreviewMock(),
}));

function preview(over: Partial<PreviewSummary> = {}): PreviewSummary {
  return {
    id: 'pv1',
    prNumber: 7,
    title: 'Add a feature',
    headRef: 'feat/x',
    headSha: 'abc1234',
    authorLogin: 'octocat',
    status: 'ACTIVE',
    liveUrl: 'https://pr7.example.com',
    lastBuildId: 'b1',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    closedAt: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...over,
  };
}

function project(previewsEnabled = true): ProjectDetail {
  return { id: 'p1', previewsEnabled } as ProjectDetail;
}

function renderTab(p: ProjectDetail) {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <PreviewsTab project={p} />
      </MemoryRouter>
    </ToastProvider>,
  );
}

function querySuccess(data: PreviewSummary[]) {
  usePreviewsMock.mockReturnValue({ data, isLoading: false, isError: false, refetch: vi.fn() });
}

beforeEach(() => {
  usePreviewsMock.mockReset();
  teardownMutate.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('PreviewsTab', () => {
  it('renders each preview with its status label + live URL', () => {
    const statuses: Array<[PreviewStatus, string]> = [
      ['ACTIVE', 'Active'],
      ['PENDING', 'Building'],
      ['FAILED', 'Failed'],
      ['TORN_DOWN', 'Torn down'],
    ];
    querySuccess(
      statuses.map(([status], i) =>
        preview({ id: `pv${i}`, prNumber: i + 1, status, liveUrl: status === 'ACTIVE' ? 'https://pr1.example.com' : null }),
      ),
    );
    renderTab(project(true));

    for (const [, label] of statuses) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('PR #1')).toBeInTheDocument();
    expect(screen.getByText('https://pr1.example.com')).toBeInTheDocument();
  });

  it('shows the empty state when there are no previews', () => {
    querySuccess([]);
    renderTab(project(true));
    expect(screen.getByText(/no preview environments yet/i)).toBeInTheDocument();
  });

  it('shows the "disabled for this project" note when previewsEnabled is false', () => {
    querySuccess([preview()]);
    renderTab(project(false));
    expect(screen.getByText(/disabled for this project/i)).toBeInTheDocument();
  });

  it('tears down a preview through the confirm dialog', () => {
    querySuccess([preview({ id: 'pv9', prNumber: 9, status: 'ACTIVE' })]);
    renderTab(project(true));

    // Card button opens the confirm dialog; the dialog's confirm button fires
    // the mutation. Both read "Tear down", so confirm = the last match.
    fireEvent.click(screen.getAllByRole('button', { name: /tear down/i })[0]!);
    const buttons = screen.getAllByRole('button', { name: /tear down/i });
    fireEvent.click(buttons[buttons.length - 1]!);

    expect(teardownMutate).toHaveBeenCalledWith('pv9');
  });

  it('does NOT render a Tear down button for an already torn-down preview', () => {
    querySuccess([preview({ status: 'TORN_DOWN', closedAt: '2026-06-17T01:00:00.000Z', liveUrl: null })]);
    renderTab(project(true));
    expect(screen.queryByRole('button', { name: /tear down/i })).toBeNull();
  });

  it('shows an "expires" countdown only for live (ACTIVE/PENDING) previews, not FAILED', () => {
    querySuccess([preview({ status: 'ACTIVE' })]);
    const { unmount } = renderTab(project(true));
    expect(screen.getByText(/expires/i)).toBeInTheDocument();
    unmount();

    // A FAILED preview has nothing running to expire — no misleading countdown.
    querySuccess([preview({ status: 'FAILED', liveUrl: null })]);
    renderTab(project(true));
    expect(screen.queryByText(/expires/i)).toBeNull();
  });

  it('reads "expired" (not "expires") for a preview past its TTL but not yet reaped', () => {
    // The reaper runs hourly, so an ACTIVE preview can sit briefly past expiresAt.
    querySuccess([preview({ status: 'ACTIVE', expiresAt: new Date(Date.now() - 600_000).toISOString() })]);
    renderTab(project(true));
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
    // "expired …" must NOT contain the substring "expires".
    expect(screen.queryByText(/expires/i)).toBeNull();
  });
});
