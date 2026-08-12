import type { Risk } from '../types.js';

export type CapabilityExecutionMode = 'sync' | 'job' | 'stream';
export type ProviderIdempotency = 'native' | 'chinvat_verifiable' | 'unverifiable';
export type ConcurrencyMode = 'none' | 'optimistic' | 'exclusive';

export interface CapabilityInstance {
  /** Canonical logical capability, e.g. wordpress.create_draft. */
  capability: string;
  /** Stable provider instance id. */
  providerId: string;
  /** Execution location / node name returned as executed_at. */
  endpointId: string;
  /** Account or credential identity under which an effect occurs. */
  principalRef: string;
  /** Contract/schema hash known by the caller/registry. */
  schemaHash: string;
  /** Current invocation-time liveness. */
  live: boolean;
  /** Chinvat effect class. `read` is the only class eligible for ambiguous auto-selection. */
  risk: Risk;
  executionMode: CapabilityExecutionMode;
  idempotency?: ProviderIdempotency;
  concurrency?: ConcurrencyMode;
  /** Lower value wins for deterministic read selection. Defaults to 0. */
  preference?: number;
}

export interface ResolveRequest {
  capability: string;
  /** Optional exact endpoint/provider override. Never falls through on failure. */
  target?: string;
  /** Required account/credential identity when the capability is principal-bound. */
  principalRef?: string;
  /** Gate 1 exposes sync capabilities only, but the resolver keeps this explicit. */
  executionMode?: CapabilityExecutionMode;
}

export type ResolveErrorCode =
  | 'capability_unavailable'
  | 'unresolved_target'
  | 'ambiguous_target';

export class ResolveError extends Error {
  constructor(
    public readonly code: ResolveErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ResolveError';
  }
}

function targetMatches(instance: CapabilityInstance, target: string): boolean {
  const want = target.toLowerCase();
  return (
    instance.endpointId.toLowerCase() === want ||
    instance.providerId.toLowerCase() === want
  );
}

function deterministicOrder(a: CapabilityInstance, b: CapabilityInstance): number {
  const pref = (a.preference ?? 0) - (b.preference ?? 0);
  if (pref !== 0) return pref;
  const endpoint = a.endpointId.localeCompare(b.endpointId);
  if (endpoint !== 0) return endpoint;
  return a.providerId.localeCompare(b.providerId);
}

/**
 * Resolve one canonical capability to one execution instance.
 *
 * Invariants:
 * - invocation-time liveness is authoritative;
 * - explicit targets are exact and never fall through;
 * - principal identity is a routing constraint, never a tiebreak;
 * - ambiguous effectful work never auto-selects;
 * - multiple reads may auto-select only when they share one principal;
 * - result is deterministic for an identical registry snapshot.
 */
export function resolveCapability(
  instances: readonly CapabilityInstance[],
  request: ResolveRequest
): CapabilityInstance {
  let candidates = instances.filter(
    (instance) => instance.capability === request.capability && instance.live
  );

  if (request.principalRef !== undefined) {
    candidates = candidates.filter(
      (instance) => instance.principalRef === request.principalRef
    );
  }

  if (request.executionMode !== undefined) {
    candidates = candidates.filter(
      (instance) => instance.executionMode === request.executionMode
    );
  }

  if (request.target) {
    const exact = candidates.filter((instance) => targetMatches(instance, request.target!));
    if (exact.length !== 1) {
      throw new ResolveError(
        'unresolved_target',
        `target '${request.target}' does not resolve to exactly one live '${request.capability}' instance`
      );
    }
    return exact[0];
  }

  if (candidates.length === 0) {
    throw new ResolveError(
      'capability_unavailable',
      `no live instance is available for '${request.capability}'`
    );
  }

  if (candidates.length === 1) return candidates[0];

  const principals = new Set(candidates.map((candidate) => candidate.principalRef));
  const allReads = candidates.every((candidate) => candidate.risk === 'read');
  const sameMode = new Set(candidates.map((candidate) => candidate.executionMode)).size === 1;

  if (allReads && principals.size === 1 && sameMode) {
    return [...candidates].sort(deterministicOrder)[0];
  }

  throw new ResolveError(
    'ambiguous_target',
    `multiple non-equivalent live instances exist for '${request.capability}'; specify target`
  );
}
