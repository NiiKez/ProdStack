/**
 * Build-time-public environment variables.
 *
 * Most project env vars are runtime secrets: ProdStack injects them into the
 * Container App as encrypted secrets at deploy time and they NEVER touch the
 * image build. But client-side web frameworks (Next.js, Vite, CRA, …) *inline*
 * a subset of env vars into the browser bundle at BUILD time, selected by a
 * naming-convention prefix (`NEXT_PUBLIC_`, `VITE_`, …). Those values are public
 * by design — they ship to every visitor's browser — so it is both safe and
 * necessary to pass them to the build as Docker `--build-arg`s.
 *
 * This module is the single source of truth for that allow-list. `runBuild`
 * uses it to pick which env vars become build args; `dockerfileGen` uses the
 * same predicate to decide which `ARG`s to declare in the generated Dockerfile.
 * Keeping the policy here (not duplicated) guarantees the two stay in lockstep.
 *
 * Anything NOT matching a prefix stays runtime-only — real secrets such as
 * `DATABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are never baked into an image
 * layer (where they'd be readable via `docker history` / a registry pull).
 */
import type { EnvVarInput } from '../azure/containerApps.js';

/**
 * Prefixes web frameworks use to mark an env var as "safe to expose to the
 * browser" — i.e. inlined into the client bundle at build time. Matching is
 * case-sensitive; project env keys are already constrained to UPPER_SNAKE_CASE
 * by the API (`^[A-Z_][A-Z0-9_]*$`), so these prefixes are the literal ones the
 * frameworks themselves require.
 */
export const BUILD_TIME_PUBLIC_PREFIXES = [
  'NEXT_PUBLIC_', // Next.js
  'VITE_', // Vite
  'REACT_APP_', // Create React App
  'GATSBY_', // Gatsby
  'NUXT_PUBLIC_', // Nuxt 3
  'PUBLIC_', // SvelteKit / Astro
] as const;

/** True when `name` is a framework "public" var that belongs in the build. */
export function isBuildTimePublicEnvKey(name: string): boolean {
  return BUILD_TIME_PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Pick the build-time-public subset of a project's env vars. The result is
 * passed to kaniko as `--build-arg`s; the full set still flows to the runtime
 * deploy unchanged, so runtime secrets are unaffected.
 */
export function selectBuildArgs(envVars: EnvVarInput[]): EnvVarInput[] {
  return envVars.filter((e) => isBuildTimePublicEnvKey(e.name));
}
