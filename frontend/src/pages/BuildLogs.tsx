import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Github,
  GitBranch,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CommitRef,
  ConfirmDialog,
  ErrorState,
  Spinner,
  StatusPill,
  useToast,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useBuild } from '@/hooks/useBuild';
import { useBuildLogs } from '@/hooks/useBuildLogs';
import { useCancelBuild } from '@/hooks/useCancelBuild';
import { isInFlight, toBuildStatus, type BuildStatus } from '@/lib/status';
import type { LogLevel } from '@/types/api';

// Ordered build phases for the stepper. CANCELLED/FAILED are terminal off-ramps
// handled separately; this is the happy-path spine.
const STAGES: ReadonlyArray<{ key: BuildStatus; label: string }> = [
  { key: 'queued', label: 'Queued' },
  { key: 'cloning', label: 'Clone' },
  { key: 'building', label: 'Build' },
  { key: 'pushing', label: 'Push' },
  { key: 'deploying', label: 'Deploy' },
  { key: 'ready', label: 'Ready' },
];

const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  STAGES.map((s, i) => [s.key, i]),
);

export default function BuildLogs() {
  const { id: projectId, buildId } = useParams<{ id: string; buildId: string }>();
  const buildQuery = useBuild(buildId);
  const { lines, status: streamStatus, phase } = useBuildLogs(buildId);
  const { toast } = useToast();
  const cancelBuild = useCancelBuild();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The stream's status is the most live; fall back to the fetched build.
  const status = streamStatus ?? buildQuery.data?.status ?? 'queued';
  const normalized = toBuildStatus(status);
  const inFlight = isInFlight(status);

  usePageTitle(
    buildQuery.data
      ? `Build ${buildQuery.data.commitSha.slice(0, 7)} — ${buildQuery.data.project.name}`
      : 'Build logs — ProdStack',
  );

  const handleCancel = async () => {
    if (!buildId) return;
    try {
      const result = await cancelBuild.mutateAsync({ buildId, ...(projectId ? { projectId } : {}) });
      toast({
        title: result.cancelRequested ? 'Cancelling build…' : 'Build cancelled',
        variant: 'success',
      });
      setConfirmOpen(false);
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Could not cancel build',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  if (buildQuery.isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink projectId={projectId} />
        <ErrorState
          title="Couldn't load this build"
          description="It may have been deleted, or you don't have access."
          onRetry={() => void buildQuery.refetch()}
        />
      </div>
    );
  }

  const build = buildQuery.data;

  return (
    <div className="flex flex-col gap-5">
      <BackLink projectId={projectId} />

      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            {build ? (
              <>
                <div className="flex items-center gap-2">
                  <CommitRef sha={build.commitSha} />
                  <span className="truncate text-sm text-slate-200">
                    {build.commitMessage}
                  </span>
                </div>
                <a
                  href={`https://github.com/${build.project.githubRepoFullName}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex w-fit items-center gap-1.5 rounded-md font-mono text-xs text-slate-400 transition-colors hover:text-slate-200"
                >
                  <Github size={13} aria-hidden className="shrink-0" />
                  {build.project.githubRepoFullName}
                  <ExternalLink size={11} aria-hidden className="shrink-0 opacity-70" />
                </a>
              </>
            ) : (
              <div className="h-9 w-48 animate-pulse rounded bg-slate-800" />
            )}
          </div>
          <div className="flex items-center gap-2">
            {build && (
              <Badge mono variant="accent">
                <GitBranch size={12} aria-hidden />
                {build.branch}
              </Badge>
            )}
            <StatusPill status={status} />
            {inFlight && (
              <Button
                variant="danger"
                size="sm"
                leadingIcon={<XCircle size={14} />}
                onClick={() => setConfirmOpen(true)}
                title="Stop this running build"
              >
                Cancel
              </Button>
            )}
          </div>
        </div>

        <StageStepper status={normalized} />

        {normalized === 'failed' && build?.errorMessage && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">
            <XCircle size={15} aria-hidden className="mt-0.5 shrink-0" />
            <span className="font-mono text-xs leading-relaxed">{build.errorMessage}</span>
          </div>
        )}

        {normalized === 'ready' && build?.project.liveUrl && (
          <a
            href={build.project.liveUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 font-mono text-xs text-emerald-300 transition-colors hover:bg-emerald-500/10"
          >
            <CheckCircle2 size={13} aria-hidden className="shrink-0" />
            <span className="truncate">{build.project.liveUrl}</span>
            <ExternalLink size={12} aria-hidden className="shrink-0 opacity-70" />
          </a>
        )}
      </Card>

      <LogViewport lines={lines} phase={phase} />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Cancel this build?"
        description="The build will stop and be marked as cancelled."
        confirmLabel="Cancel build"
        cancelLabel="Keep building"
        variant="danger"
        loading={cancelBuild.isPending}
        onConfirm={() => void handleCancel()}
      />
    </div>
  );
}

function BackLink({ projectId }: { projectId: string | undefined }) {
  return (
    <Link
      to={projectId ? `/projects/${projectId}?tab=builds` : '/dashboard'}
      className={cn(
        'group inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-slate-400',
        'transition-colors hover:text-slate-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
      )}
    >
      <ArrowLeft
        size={14}
        aria-hidden
        className="transition-transform group-hover:-translate-x-0.5"
      />
      Back to project
    </Link>
  );
}

function StageStepper({ status }: { status: BuildStatus }) {
  const failed = status === 'failed';
  const cancelled = status === 'cancelled';
  const current = STAGE_INDEX[status] ?? 0;

  return (
    <ol className="flex flex-wrap items-center gap-y-2">
      {STAGES.map((stage, i) => {
        const reached = current >= i;
        const isCurrent = current === i && !failed && status !== 'ready';
        // A failed/cancelled build marks the stage it died on as the error node.
        const erroredHere = (failed || cancelled) && i === current;
        // A completed (passed) stage is everything reached that isn't the
        // currently-running or errored node — these get the lime "done" tint.
        const done = reached && !isCurrent && !erroredHere;
        return (
          <li key={stage.key} className="flex items-center">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                erroredHere
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
                  : isCurrent
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    : done
                      ? 'border-accent-400/40 bg-accent-400/10 text-accent-300'
                      : 'border-slate-800 bg-slate-900/60 text-slate-500',
              )}
            >
              {erroredHere ? (
                <XCircle size={12} aria-hidden />
              ) : done ? (
                <CheckCircle2 size={12} aria-hidden />
              ) : isCurrent ? (
                <Spinner size="sm" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />
              )}
              {stage.label}
            </span>
            {i < STAGES.length - 1 && (
              <span
                className={cn(
                  'mx-1 h-px w-5 shrink-0 transition-colors sm:w-6',
                  done ? 'bg-accent-400/40' : 'bg-slate-800',
                )}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

const LEVEL_STYLES: Record<LogLevel, string> = {
  INFO: 'text-slate-400',
  STEP: 'text-accent-400 font-medium',
  WARN: 'text-amber-400',
  ERROR: 'text-rose-400',
  SUCCESS: 'text-emerald-400',
};

interface LogViewportProps {
  lines: ReturnType<typeof useBuildLogs>['lines'];
  phase: ReturnType<typeof useBuildLogs>['phase'];
}

function LogViewport({ lines, phase }: LogViewportProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Autoscroll to bottom on new lines unless the user scrolled up.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  };

  const indicator = useMemo(() => {
    switch (phase) {
      case 'connecting':
        return { label: 'Connecting…', cls: 'text-slate-400', dot: 'bg-slate-400 animate-pulse' };
      case 'streaming':
        return { label: 'Streaming', cls: 'text-emerald-300', dot: 'bg-emerald-400 animate-pulse' };
      case 'done':
        return { label: 'Stream ended', cls: 'text-slate-400', dot: 'bg-slate-500' };
      case 'error':
        return { label: 'Disconnected', cls: 'text-rose-300', dot: 'bg-rose-400' };
    }
  }, [phase]);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-black/40 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
          </span>
          <h2 className="text-sm font-semibold text-slate-100">Build logs</h2>
        </div>
        <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', indicator.cls)}>
          <span className={cn('h-1.5 w-1.5 rounded-full', indicator.dot)} aria-hidden />
          {indicator.label}
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-[60vh] overflow-auto bg-slate-950 p-4 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-slate-600">
            {phase === 'connecting' ? 'Waiting for output…' : 'No log output.'}
          </div>
        ) : (
          <ol className="flex flex-col">
            {lines.map((line) => (
              <li
                key={line.seq}
                className="flex gap-3 whitespace-pre-wrap break-all rounded px-1 -mx-1 hover:bg-slate-900/60"
              >
                <span
                  className="select-none text-right text-slate-700 tabular-nums"
                  style={{ minWidth: '3ch' }}
                >
                  {line.seq}
                </span>
                <span className={LEVEL_STYLES[line.level] ?? 'text-slate-400'}>
                  {line.message}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
