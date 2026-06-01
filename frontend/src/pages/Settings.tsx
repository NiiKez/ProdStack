import { useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Github,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Input,
  Skeleton,
  Spinner,
  useToast,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useAccount } from '@/hooks/useAccount';
import { useDisconnectGithub } from '@/hooks/useDisconnectGithub';
import { useTestAzure } from '@/hooks/useTestAzure';
import { useDeleteAccount } from '@/hooks/useDeleteAccount';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { AccountInfo } from '@/types/api';

export default function Settings() {
  usePageTitle('Settings — ProdStack');

  const { data: account, isLoading, isError, refetch } = useAccount();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-400">
          Manage your account, connections, and Azure access.
        </p>
      </header>

      {isLoading ? (
        <SettingsSkeleton />
      ) : isError || !account ? (
        <ErrorState
          title="Couldn't load your account"
          description="Something went wrong fetching your account details."
          onRetry={() => void refetch()}
        />
      ) : (
        <div className="flex max-w-3xl flex-col gap-5">
          <AccountCard account={account} />
          <GithubCard account={account} />
          <AzureCard account={account} />
          <DangerZoneCard account={account} />
        </div>
      )}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i} className="flex flex-col gap-3 p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      ))}
    </div>
  );
}

// ---- 1. Account ----------------------------------------------------------

function AccountCard({ account }: { account: AccountInfo }) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <h2 className="text-sm font-semibold text-slate-200">Account</h2>
      <div className="flex items-center gap-3">
        <Avatar
          src={account.avatarUrl ?? undefined}
          alt={account.githubLogin}
          size="lg"
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-slate-100">
            {account.githubLogin}
          </span>
          <span className="truncate text-xs text-slate-400">
            {account.email ?? '—'}
          </span>
        </div>
        <span className="ml-auto shrink-0 text-right">
          <span className="block text-lg font-semibold text-slate-100">
            {account.counts.projects}
          </span>
          <span className="block text-xs text-slate-500">
            {account.counts.projects === 1 ? 'project' : 'projects'}
          </span>
        </span>
      </div>
    </Card>
  );
}

// ---- 2. GitHub connection ------------------------------------------------

function GithubCard({ account }: { account: AccountInfo }) {
  const { toast } = useToast();
  const disconnect = useDisconnectGithub();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const connected = account.github.connected;
  const hasProjects = account.counts.projects > 0;

  const handleConfirm = async () => {
    try {
      // On success the server clears the session; the hook redirects to '/'.
      await disconnect.mutateAsync();
    } catch (err) {
      setConfirmOpen(false);
      const friendly =
        err instanceof ApiError && err.code === 'HAS_ACTIVE_PROJECTS'
          ? 'Delete your projects before disconnecting GitHub.'
          : err instanceof Error
            ? err.message
            : '';
      toast({
        title: 'Could not disconnect GitHub.',
        variant: 'error',
        ...(friendly ? { description: friendly } : {}),
      });
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Github size={16} aria-hidden />
          GitHub connection
        </h2>
        <Badge variant={connected ? 'success' : 'neutral'}>
          {connected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      {account.github.scopes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Scopes
          </span>
          <div className="flex flex-wrap gap-1.5">
            {account.github.scopes.map((scope) => (
              <Badge key={scope} mono variant="neutral">
                {scope}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-slate-800 pt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-400">
            Disconnect to revoke ProdStack's access to your GitHub account.
          </p>
          <Button
            variant="danger"
            size="sm"
            disabled={hasProjects || !connected}
            onClick={() => setConfirmOpen(true)}
          >
            Disconnect
          </Button>
        </div>
        {hasProjects && (
          <p className="text-xs text-amber-300">
            Delete your projects before disconnecting GitHub.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect GitHub?"
        description="This revokes ProdStack's access and signs you out. You can reconnect by signing in again."
        confirmLabel="Disconnect"
        variant="danger"
        loading={disconnect.isPending}
        onConfirm={() => void handleConfirm()}
      />
    </Card>
  );
}

// ---- 3. Azure ------------------------------------------------------------

function AzureCard({ account }: { account: AccountInfo }) {
  const test = useTestAzure();
  const managed = account.azure.mode === 'managed-identity';

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Cloud size={16} aria-hidden />
          Azure
        </h2>
        <Badge variant={managed ? 'success' : 'neutral'}>
          {managed ? 'Managed Identity' : 'Stub (local dev)'}
        </Badge>
      </div>

      <p className="text-sm text-slate-400">
        ProdStack authenticates to Azure with a system-assigned managed
        identity — no secrets or service-principal credentials are stored. The
        identity holds only the least-privilege roles it needs to provision and
        roll your Container Apps.
      </p>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Detail label="Region" value={account.azure.region} />
        <Detail
          label="Subscription"
          value={account.azure.subscriptionId ?? '—'}
          mono
        />
        <Detail label="Resource group" value={account.azure.resourceGroup ?? '—'} />
      </dl>

      <div className="flex flex-col gap-3 border-t border-slate-800 pt-4">
        <div>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ShieldCheck size={14} />}
            loading={test.isPending}
            onClick={() => test.mutate()}
          >
            Test connection
          </Button>
        </div>

        {test.isPending && (
          <p className="flex items-center gap-2 text-sm text-slate-400">
            <Spinner size="sm" />
            Testing…
          </p>
        )}
        {!test.isPending && test.isError && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <XCircle size={16} aria-hidden />
            Failed: {test.error instanceof Error ? test.error.message : 'Request failed'}
          </p>
        )}
        {!test.isPending && test.data && (
          test.data.ok ? (
            <p className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 size={16} aria-hidden />
              Connected ✓
              {typeof test.data.latencyMs === 'number' && (
                <span className="text-slate-400">({test.data.latencyMs} ms)</span>
              )}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-rose-400">
              <XCircle size={16} aria-hidden />
              Failed: {test.data.detail ?? 'Azure connection check failed.'}
            </p>
          )
        )}
      </div>
    </Card>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={mono ? 'truncate font-mono text-xs text-slate-300' : 'text-slate-300'}>
        {value}
      </dd>
    </div>
  );
}

// ---- 4. Danger zone ------------------------------------------------------

function DangerZoneCard({ account }: { account: AccountInfo }) {
  const { toast } = useToast();
  const deleteAccount = useDeleteAccount();
  const [confirmInput, setConfirmInput] = useState('');

  // Confirm against the email when present; otherwise fall back to "DELETE".
  const phrase = account.email ?? 'DELETE';
  const canDelete = confirmInput === phrase;

  const handleDelete = async () => {
    if (!canDelete) return;
    try {
      // On success the server clears the session; the hook redirects to '/'.
      await deleteAccount.mutateAsync();
    } catch (err) {
      const description = err instanceof Error ? err.message : '';
      toast({
        title: 'Could not delete account.',
        variant: 'error',
        ...(description ? { description } : {}),
      });
    }
  };

  return (
    <Card className="flex flex-col gap-3 border-rose-500/30 p-5">
      <h2 className="text-sm font-semibold text-rose-300">Danger zone</h2>
      <p className="text-sm text-slate-400">
        Permanently deletes your account, projects, and their Container Apps.
        This cannot be undone.
      </p>
      <Input
        label={`Type "${phrase}" to confirm`}
        value={confirmInput}
        onChange={(e) => setConfirmInput(e.target.value)}
        placeholder={phrase}
        autoComplete="off"
      />
      <div className="flex items-center justify-end">
        <Button
          variant="danger"
          leadingIcon={<Trash2 size={16} />}
          disabled={!canDelete}
          loading={deleteAccount.isPending}
          onClick={() => void handleDelete()}
        >
          Delete account
        </Button>
      </div>
    </Card>
  );
}
