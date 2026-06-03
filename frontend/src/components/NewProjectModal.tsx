import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Lock, Search } from 'lucide-react';
import { Button, Input, Modal, Spinner, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { REPO_URL_PATTERN, slugify, deriveNameFromRepoUrl, mapApiError } from '@/lib/repo';
import { filterRepos, repoToFormValues } from '@/lib/githubRepos';
import { useCreateProject } from '@/hooks/useCreateProject';
import { useGithubRepos } from '@/hooks/useGithubRepos';
import type { GithubRepo, ProjectSummary } from '@/types/api';

const schema = z.object({
  repoUrl: z.string().regex(REPO_URL_PATTERN, 'Must be a GitHub repo URL'),
  branch: z.string().min(1, 'Required'),
  name: z.string().min(1, 'Required').max(50, 'Max 50 chars'),
});

type FormValues = z.infer<typeof schema>;

type SourceMode = 'picker' | 'manual';

export interface NewProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (project: ProjectSummary) => void;
}

export function NewProjectModal({ open, onOpenChange, onCreated }: NewProjectModalProps) {
  const { toast } = useToast();
  const createProject = useCreateProject();

  // Only fetch the repo list while the modal is open. The hook is lazy so a
  // closed modal never hits the network.
  const repos = useGithubRepos(open);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    getValues,
    watch,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { repoUrl: '', branch: 'main', name: '' },
    mode: 'onBlur',
  });

  // Source mode: default to the picker; fall back to manual URL entry on demand
  // or automatically when the repos query fails / comes back empty.
  const [mode, setMode] = useState<SourceMode>('picker');
  const [search, setSearch] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  // Reset whenever the modal closes to avoid stale state on next open.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      reset({ repoUrl: '', branch: 'main', name: '' });
      createProject.reset();
      setMode('picker');
      setSearch('');
      setSelectedRepo(null);
    }
    prevOpenRef.current = open;
  }, [open, reset, createProject]);

  // When the picker is unavailable (query errored or returned no repos), drop
  // the user into manual mode so the modal is never a dead end. We only force
  // the switch automatically while still in picker mode — once the user has
  // chosen manual themselves, respect it.
  const pickerUnavailable =
    repos.isError || (repos.isSuccess && (repos.data?.length ?? 0) === 0);
  useEffect(() => {
    if (open && mode === 'picker' && pickerUnavailable) {
      setMode('manual');
    }
  }, [open, mode, pickerUnavailable]);

  const nameValue = watch('name');
  const derivedSlug = nameValue ? slugify(nameValue) : '';

  const handleRepoBlur = useCallback(() => {
    const repoUrl = getValues('repoUrl');
    const currentName = getValues('name');
    if (!currentName && repoUrl) {
      const derived = deriveNameFromRepoUrl(repoUrl);
      if (derived) {
        setValue('name', derived, { shouldValidate: true, shouldDirty: true });
      }
    }
  }, [getValues, setValue]);

  const filtered = useMemo(
    () => filterRepos(repos.data ?? [], search),
    [repos.data, search]
  );

  const handleSelectRepo = useCallback(
    (repo: GithubRepo) => {
      const values = repoToFormValues(repo);
      setValue('repoUrl', values.repoUrl, { shouldValidate: true, shouldDirty: true });
      setValue('branch', values.branch, { shouldValidate: true, shouldDirty: true });
      setValue('name', values.name, { shouldValidate: true, shouldDirty: true });
      setSelectedRepo(repo.fullName);
    },
    [setValue]
  );

  const requestClose = useCallback(
    (next: boolean) => {
      if (!next && isDirty && !isSubmitting) {
        const confirmed = window.confirm('Discard your changes?');
        if (!confirmed) return;
      }
      onOpenChange(next);
    },
    [isDirty, isSubmitting, onOpenChange]
  );

  const onSubmit = handleSubmit(async (values) => {
    try {
      const project = await createProject.mutateAsync(values);
      toast({
        title: 'Project created. Push a commit to deploy.',
        variant: 'success',
      });
      onCreated?.(project);
      onOpenChange(false);
    } catch (err) {
      const message = mapApiError(err);
      if (err instanceof ApiError && err.code === 'INVALID_REPO_URL') {
        setError('repoUrl', { type: 'server', message });
      } else if (err instanceof ApiError && err.code === 'REPO_NOT_ACCESSIBLE') {
        setError('repoUrl', { type: 'server', message });
      } else if (err instanceof ApiError && err.code === 'DOCKERFILE_NOT_FOUND') {
        setError('repoUrl', { type: 'server', message });
      } else {
        setError('root', { type: 'server', message });
      }
    }
  });

  // Register the repoUrl field manually so we can attach onBlur alongside RHF.
  const repoField = register('repoUrl');

  const rootError = errors.root?.message;
  const selectedRepoUrl = watch('repoUrl');

  return (
    <Modal
      open={open}
      onOpenChange={requestClose}
      title="Create a new project"
      description="Connect a GitHub repo and we'll build & deploy it on every push."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {mode === 'picker' ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-200">GitHub repository</span>
            {repos.isLoading ? (
              <div
                className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-6 text-sm text-slate-400"
                aria-live="polite"
              >
                <Spinner size="sm" />
                Loading your repositories…
              </div>
            ) : (
              <>
                <Input
                  type="search"
                  aria-label="Search repositories"
                  placeholder="Search repositories…"
                  autoComplete="off"
                  spellCheck={false}
                  leadingIcon={<Search aria-hidden />}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <ul
                  className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-1"
                  aria-label="Repositories"
                >
                  {filtered.length === 0 ? (
                    <li className="px-3 py-4 text-center text-sm text-slate-400">
                      No repositories match “{search}”.
                    </li>
                  ) : (
                    filtered.map((repo) => {
                      const isSelected = repo.fullName === selectedRepo;
                      return (
                        <li key={repo.fullName}>
                          <button
                            type="button"
                            onClick={() => handleSelectRepo(repo)}
                            aria-pressed={isSelected}
                            className={
                              'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm ' +
                              'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 ' +
                              (isSelected
                                ? 'bg-accent-400/15 text-slate-100'
                                : 'text-slate-200 hover:bg-slate-800')
                            }
                          >
                            <span className="truncate font-medium">{repo.fullName}</span>
                            <span
                              className={
                                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ' +
                                (repo.private
                                  ? 'bg-slate-800 text-slate-300'
                                  : 'bg-slate-800 text-slate-400')
                              }
                            >
                              {repo.private && <Lock className="h-3 w-3" aria-hidden />}
                              {repo.private ? 'Private' : 'Public'}
                            </span>
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
                {errors.repoUrl?.message && (
                  <p className="text-xs text-rose-400">{errors.repoUrl.message}</p>
                )}
                {selectedRepoUrl && (
                  <p className="text-xs text-slate-400">
                    Selected: <span className="font-mono text-slate-300">{selectedRepoUrl}</span>
                  </p>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => setMode('manual')}
              className="self-start text-xs font-medium text-accent-400 hover:text-accent-300 hover:underline"
            >
              Can&apos;t find it? Paste a URL instead
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Input
              label="GitHub repo URL"
              placeholder="https://github.com/owner/repo"
              autoComplete="off"
              spellCheck={false}
              {...(errors.repoUrl?.message ? { error: errors.repoUrl.message } : {})}
              {...repoField}
              onBlur={(e) => {
                repoField.onBlur(e);
                handleRepoBlur();
              }}
            />
            {pickerUnavailable && (
              <p className="text-xs text-slate-400">
                Couldn&apos;t load your repos — paste a URL instead.
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setMode('picker');
                setSearch('');
              }}
              disabled={pickerUnavailable}
              className="mt-1 self-start text-xs font-medium text-accent-400 hover:text-accent-300 hover:underline disabled:cursor-not-allowed disabled:text-slate-500 disabled:no-underline"
            >
              Pick from your repositories
            </button>
          </div>
        )}

        <Input
          label="Branch"
          placeholder="main"
          autoComplete="off"
          spellCheck={false}
          {...(errors.branch?.message ? { error: errors.branch.message } : {})}
          {...register('branch')}
        />
        <div className="flex flex-col gap-1">
          <Input
            label="Project name"
            placeholder="my-app"
            autoComplete="off"
            spellCheck={false}
            {...(errors.name?.message ? { error: errors.name.message } : {})}
            {...register('name')}
          />
          <p className="text-xs text-slate-400">
            {derivedSlug ? (
              <>
                Slug: <span className="font-mono text-slate-300">{derivedSlug}</span>. Used as
                the Container App suffix.
              </>
            ) : (
              <>Used as the Container App suffix.</>
            )}
          </p>
        </div>

        {rootError && (
          <p
            role="alert"
            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
          >
            {rootError}
          </p>
        )}

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => requestClose(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting || createProject.isPending}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
