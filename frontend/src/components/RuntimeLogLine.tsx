import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import {
  formatLogClock,
  formatLogField,
  parseLogLine,
  type LogSeverity,
} from '@/lib/runtimeLogs';
import type { RuntimeLogLine as RuntimeLogLineData } from '@/types/api';

/**
 * One row in the runtime-log viewer. Plain-text (or non-decodable) lines render
 * verbatim — identical to the original tail. A structured JSON line (winston /
 * pino / bunyan …) is decoded by {@link parseLogLine} into a coloured level
 * chip + the human message, with the remaining fields tucked behind a collapse
 * toggle so the noisy `requestId`/`responseTime`/`service`/… don't drown the
 * message. The parsing lives in `lib/runtimeLogs.ts` (unit-tested); this file is
 * only markup.
 */

const SEVERITY_VARIANT: Record<LogSeverity, BadgeVariant> = {
  debug: 'neutral',
  info: 'success',
  warn: 'warn',
  error: 'danger',
};

export function RuntimeLogLine({ line }: { line: RuntimeLogLineData }) {
  const parsed = parseLogLine(line.message);
  const isStderr = line.stream === 'stderr';
  const clock = formatLogClock(line.ts);
  const [expanded, setExpanded] = useState(false);

  if (parsed.kind === 'raw') {
    return (
      <div className="flex gap-3">
        <span className="shrink-0 select-none text-slate-600">{clock}</span>
        <span
          className={cn(
            'whitespace-pre-wrap break-all',
            isStderr ? 'text-rose-300' : 'text-slate-300',
          )}
        >
          {parsed.text}
        </span>
      </div>
    );
  }

  const fieldEntries = Object.entries(parsed.fields);
  const hasFields = fieldEntries.length > 0;
  const levelVariant: BadgeVariant = parsed.severity
    ? SEVERITY_VARIANT[parsed.severity]
    : 'neutral';

  return (
    <div className="py-px">
      <div className="flex items-start gap-3">
        <span className="shrink-0 select-none pt-0.5 text-slate-600">{clock}</span>
        {parsed.level !== null && (
          <Badge variant={levelVariant} className="shrink-0 px-1.5 py-0 uppercase">
            {parsed.level}
          </Badge>
        )}
        <span
          className={cn(
            'min-w-0 flex-1 whitespace-pre-wrap break-all',
            isStderr ? 'text-rose-200' : 'text-slate-200',
          )}
        >
          {parsed.message}
        </span>
        {hasFields && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide log fields' : `Show ${fieldEntries.length} log fields`}
            className="group flex shrink-0 items-center gap-1 text-slate-500 hover:text-slate-300"
          >
            <ChevronRight
              size={12}
              aria-hidden
              className={cn('transition-transform', expanded && 'rotate-90')}
            />
            <span className="text-[10px] tabular-nums">{fieldEntries.length}</span>
          </button>
        )}
      </div>

      {expanded && hasFields && (
        <dl className="ml-14 mt-1 flex flex-col gap-0.5 border-l border-slate-800 pl-3">
          {fieldEntries.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="shrink-0 select-none text-slate-500">{key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-all text-slate-400">
                {formatLogField(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
