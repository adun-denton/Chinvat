import type { Risk, Tier } from './types.js';

export type PolicyDecision = 'run' | 'approval' | 'reject';

/**
 * The bridge: operation risk × module tier → what happens.
 *
 *              read        act         dangerous
 * observe      run         reject      reject
 * approve      run         approval    approval
 * autonomous   run         run         run
 */
export function decide(risk: Risk, tier: Tier): PolicyDecision {
  if (risk === 'read') return 'run';
  if (tier === 'observe') return 'reject';
  if (tier === 'approve') return 'approval';
  return 'run';
}
