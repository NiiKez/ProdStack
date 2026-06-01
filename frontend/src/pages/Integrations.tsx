import { Link } from 'react-router-dom';
import {
  Cloud,
  Github,
  Mail,
  MessageSquare,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useAccount } from '@/hooks/useAccount';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { AccountInfo } from '@/types/api';

export default function Integrations() {
  usePageTitle('Integrations — ProdStack');

  const { data: account, isLoading, isError, refetch } = useAccount();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-slate-100">Integrations</h1>
        <p className="text-sm text-slate-400">
          Services connected to your ProdStack account.
        </p>
      </header>

      {isLoading ? (
        <IntegrationsSkeleton />
      ) : isError || !account ? (
        <ErrorState
          title="Couldn't load integrations"
          description="Something went wrong fetching your connected services."
          onRetry={() => void refetch()}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <GithubIntegration account={account} />
          <AzureIntegration account={account} />
          <ComingSoonIntegration
            icon={MessageSquare}
            name="Slack"
            description="Get build and deployment notifications in your channels."
          />
          <ComingSoonIntegration
            icon={Mail}
            name="Email"
            description="Email alerts when a build fails or a deployment goes live."
          />
          <ComingSoonIntegration
            icon={Webhook}
            name="Webhooks"
            description="Send deployment events to your own endpoints."
          />
        </div>
      )}
    </div>
  );
}

function IntegrationsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <Card key={i} className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </Card>
      ))}
    </div>
  );
}

// ---- Shared card chrome ---------------------------------------------------

interface IntegrationShellProps {
  icon: LucideIcon;
  name: string;
  badge: React.ReactNode;
  children: React.ReactNode;
  /** When true, dim the card (no active connection / coming soon). */
  muted?: boolean;
  interactive?: boolean;
}

function IntegrationShell({
  icon: Icon,
  name,
  badge,
  children,
  muted = false,
  interactive = false,
}: IntegrationShellProps) {
  return (
    <Card
      interactive={interactive}
      className={cn('flex flex-col gap-3 p-5', muted && 'opacity-60')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800/80 text-slate-300 [&_svg]:h-5 [&_svg]:w-5"
          >
            <Icon />
          </span>
          <h2 className="text-sm font-semibold text-slate-100">{name}</h2>
        </div>
        {badge}
      </div>
      {children}
    </Card>
  );
}

// ---- GitHub ---------------------------------------------------------------

function GithubIntegration({ account }: { account: AccountInfo }) {
  const connected = account.github.connected;
  const scopes = account.github.scopes;

  return (
    <IntegrationShell
      icon={Github}
      name="GitHub"
      interactive
      badge={
        <Badge variant={connected ? 'success' : 'neutral'}>
          {connected ? 'Connected' : 'Disconnected'}
        </Badge>
      }
    >
      <p className="text-sm text-slate-400">
        Source of your repos, push webhooks, and OAuth sign-in.
      </p>
      <p className="truncate text-xs text-slate-500">
        {scopes.length > 0 ? `Scopes: ${scopes.join(', ')}` : 'No scopes granted'}
      </p>
      <ManageLink />
    </IntegrationShell>
  );
}

// ---- Azure ----------------------------------------------------------------

function AzureIntegration({ account }: { account: AccountInfo }) {
  const managed = account.azure.mode === 'managed-identity';

  return (
    <IntegrationShell
      icon={Cloud}
      name="Azure"
      interactive
      badge={
        <Badge variant={managed ? 'success' : 'neutral'}>
          {managed ? 'Connected' : 'Not configured'}
        </Badge>
      }
    >
      <p className="text-sm text-slate-400">
        Container Apps host your deployments via a managed identity — no secrets
        stored.
      </p>
      <p className="truncate text-xs text-slate-500">Region: {account.azure.region}</p>
      <ManageLink />
    </IntegrationShell>
  );
}

function ManageLink() {
  return (
    <Link
      to="/settings"
      className={cn(
        'mt-auto inline-flex w-fit items-center text-xs font-medium text-indigo-300 hover:text-indigo-200',
        'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400',
      )}
    >
      Manage
    </Link>
  );
}

// ---- Coming soon ----------------------------------------------------------

interface ComingSoonProps {
  icon: LucideIcon;
  name: string;
  description: string;
}

function ComingSoonIntegration({ icon, name, description }: ComingSoonProps) {
  return (
    <IntegrationShell
      icon={icon}
      name={name}
      muted
      badge={<Badge variant="neutral">Coming soon</Badge>}
    >
      <p className="text-sm text-slate-400">{description}</p>
    </IntegrationShell>
  );
}
