import { useCallback, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Input, Modal, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useCreateProject } from '@/hooks/useCreateProject';
import type { ProjectSummary } from '@/types/api';

// Mirrors the backend regex in `routes/projects.ts` — https only, no trailing
// slash other than the optional `.git`. Keeping them aligned avoids the case
// where the client accepts a URL that the API immediately rejects.
const REPO_URL_PATTERN =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;

const schema = z.object({
  repoUrl: z.string().regex(REPO_URL_PATTERN, 'Must be a GitHub repo URL'),
  branch: z.string().min(1, 'Required'),
  name: z.string().min(1, 'Required').max(50, 'Max 50 chars'),
});

type FormValues = z.infer<typeof schema>;

export interface NewProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (project: ProjectSummary) => void;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveNameFromRepoUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const lastSegment = trimmed.split('/').pop() ?? '';
  const withoutGit = lastSegment.replace(/\.git$/, '');
  return withoutGit;
}

function mapApiError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'INVALID_REPO_URL':
        return "That doesn't look like a GitHub repo URL.";
      case 'REPO_NOT_ACCESSIBLE':
        return "ProdStack can't see that repo. Check the URL or your GitHub scopes.";
      case 'WEBHOOK_REGISTRATION_FAILED':
        return "Couldn't register the GitHub webhook.";
      case 'DOCKERFILE_NOT_FOUND':
        return 'No Dockerfile at the repo root.';
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export function NewProjectModal({ open, onOpenChange, onCreated }: NewProjectModalProps) {
  const { toast } = useToast();
  const createProject = useCreateProject();

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

  // Reset whenever the modal closes to avoid stale state on next open.
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      reset({ repoUrl: '', branch: 'main', name: '' });
      createProject.reset();
    }
    prevOpenRef.current = open;
  }, [open, reset, createProject]);

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

  return (
    <Modal
      open={open}
      onOpenChange={requestClose}
      title="Create a new project"
      description="Connect a GitHub repo and we'll build & deploy it on every push."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
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
