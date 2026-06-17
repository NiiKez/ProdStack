import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, GitBranch, GitPullRequest, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  RelativeTime,
  Skeleton,
  useToast,
} from '@/components/ui';
import { usePreviews, useTeardownPreview } from '@/hooks/usePreviews';
import type { PreviewStatus, PreviewSummary, ProjectDetail } from '@/types/api';

const STATUS_BADGE: Record<PreviewStatus, { variant: 'success' | 'accent' | 'danger' | 'neutral'; label: string }> = {
  ACTIVE: { variant: 'success', label: 'Active' },
  PENDING: { variant: 'accent', label: 'Building' },
  FAILED: { variant: 'danger', label: 'Failed' },
  TORN_DOWN: { variant: 'neutral', label: 'Torn down' },
};

interface PreviewsTabProps {
  project: ProjectDetail;
}

export function PreviewsTab({ project }: PreviewsTabProps) {
  const { toast } = useToast();
  const query = usePreviews(project.id);
  const teardown = useTeardownPreview(project.id);
  const [target, setTarget] = useState<PreviewSummary | null>(null);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Preview URL copied', variant: 'success' });
    } catch {
      toast({ title: 'Could not copy preview URL', variant: 'error' });
    }
  };

  const handleTeardown = async () => {
    if (!target) return;
    try {
      await teardown.mutateAsync(target.id);
      toast({ title: `Preview for PR #${target.prNumber} torn down.`, variant: 'success' });
      setTarget(null);
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({ title: 'Teardown failed', variant: 'error', ...(description ? { description } : {}) });
    }
  };

  if (query.isLoading) {
    return (
      <Card className="p-4">
        <Skeleton lines={4} />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load preview environments"
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const previews = query.data ?? [];

  if (previews.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {!project.previewsEnabled && <PreviewsDisabledNote />}
        <EmptyState
          title="No preview environments yet"
          description="Open a pull request to spin one up. Each PR from a trusted author gets its own throwaway URL, built and deployed like the real app."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!project.previewsEnabled && <PreviewsDisabledNote />}

      {previews.map((p) => {
        const badge = STATUS_BADGE[p.status];
        const open = p.status !== 'TORN_DOWN';
        return (
          <Card key={p.id} className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-100">
                    <GitPullRequest size={14} aria-hidden className="text-slate-500" />
                    PR #{p.prNumber}
                  </span>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  <Badge mono variant="accent">
                    <GitBranch size={12} aria-hidden />
                    {p.headRef}
                  </Badge>
                </div>
                <span className="truncate text-sm text-slate-300">{p.title}</span>
                <span className="text-xs text-slate-500">by {p.authorLogin}</span>
              </div>
              {open && (
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Trash2 size={14} />}
                  onClick={() => setTarget(p)}
                >
                  Tear down
                </Button>
              )}
            </div>

            {p.status === 'ACTIVE' && p.liveUrl && (
              <div className="relative flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 transition-colors hover:border-slate-700">
                <a
                  href={p.liveUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex min-w-0 items-center gap-2 truncate font-mono text-xs text-slate-300 transition-colors hover:text-accent-300"
                >
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-slate-800/80 text-slate-400">
                    <ExternalLink size={11} aria-hidden />
                  </span>
                  <span className="truncate">{p.liveUrl}</span>
                </a>
                <IconButton
                  label="Copy preview URL"
                  size="sm"
                  icon={<Copy />}
                  onClick={() => void handleCopy(p.liveUrl as string)}
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              {p.lastBuildId && (
                <Link
                  to={`/projects/${project.id}/builds/${p.lastBuildId}`}
                  className="rounded font-medium text-accent-400 transition-colors hover:text-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
                >
                  View build logs
                </Link>
              )}
              {(p.status === 'ACTIVE' || p.status === 'PENDING') && (
                <span>
                  {/* Past TTL but not yet reaped (the reaper runs hourly) reads
                      "expired 5 minutes ago" rather than the nonsensical
                      "expires 5 minutes ago". */}
                  {new Date(p.expiresAt).getTime() < Date.now() ? 'expired' : 'expires'}{' '}
                  <RelativeTime value={p.expiresAt} />
                </span>
              )}
            </div>
          </Card>
        );
      })}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        title="Tear down this preview?"
        description={
          target
            ? `Deletes the preview Container App for PR #${target.prNumber}. It rebuilds automatically on the next push to the PR.`
            : ''
        }
        confirmLabel="Tear down"
        variant="danger"
        loading={teardown.isPending}
        onConfirm={() => void handleTeardown()}
      />
    </div>
  );
}

function PreviewsDisabledNote() {
  return (
    <p className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-500">
      Preview environments are disabled for this project — enable them in Settings.
    </p>
  );
}
