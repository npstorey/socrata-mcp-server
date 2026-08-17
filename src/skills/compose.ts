// Pure composition logic for the `skill-guidance` prompt (sprint-154 P2).
//
// Extracted from src/index.ts's GetPrompt handler so the composition is unit
// testable: index.ts starts a transport/server at import time, so the handler
// cannot be imported directly in tests. Modality resolution (explicit arg >
// transport inference) deliberately stays in index.ts — this module receives
// the already-resolved modality and must not re-infer it.
//
// Posture semantics (additive; owner-gated at the sprint-154 deploy gate):
// - SKILL_POSTURE unset/empty -> base + modality overlay, exactly as before.
// - SKILL_POSTURE=reference-demo AND modality web -> the reference-demo
//   posture overlay is appended after the web overlay.
// - Posture never applies to local modality.
// - Unrecognized SKILL_POSTURE -> fail open to the generic composition and
//   surface a warning for the operator log.

import { BASE_SKILL } from './base.js';
import { WEB_SKILL } from './web.js';
import { LOCAL_SKILL } from './local.js';
import { WEB_REFERENCE_DEMO_SKILL } from './web-reference-demo.js';

export const SKILL_SECTION_SEPARATOR = '\n\n---\n\n';

export const RECOGNIZED_POSTURES = ['reference-demo'] as const;

export interface SkillGuidanceComposition {
  /** The full composed prompt text. */
  text: string;
  /** True when a posture overlay was appended. */
  postureApplied: boolean;
  /** Short posture decision for the handler's log line. */
  postureDecision: string;
  /** Set when SKILL_POSTURE carries an unrecognized value (fail-open case). */
  warning?: string;
}

export function composeSkillGuidance(
  modality: string,
  posture: string | undefined
): SkillGuidanceComposition {
  // Overlay selection: unchanged semantics — web gets the web overlay,
  // everything else gets the local overlay.
  const overlay = modality === 'web' ? WEB_SKILL : LOCAL_SKILL;
  const generic = BASE_SKILL + SKILL_SECTION_SEPARATOR + overlay;

  if (posture === undefined || posture === '') {
    return { text: generic, postureApplied: false, postureDecision: 'none (SKILL_POSTURE unset)' };
  }

  if (!RECOGNIZED_POSTURES.includes(posture as (typeof RECOGNIZED_POSTURES)[number])) {
    return {
      text: generic,
      postureApplied: false,
      postureDecision: `none (unrecognized SKILL_POSTURE "${posture}")`,
      warning: `Unrecognized SKILL_POSTURE value "${posture}" — recognized value(s): ${RECOGNIZED_POSTURES.map(p => `"${p}"`).join(', ')}. Serving generic ${modality} guidance (fail-open).`
    };
  }

  // Recognized posture; it only ever applies to web modality.
  if (modality !== 'web') {
    return {
      text: generic,
      postureApplied: false,
      postureDecision: `none ("${posture}" set, but posture does not apply to ${modality} modality)`
    };
  }

  return {
    text: generic + SKILL_SECTION_SEPARATOR + WEB_REFERENCE_DEMO_SKILL,
    postureApplied: true,
    postureDecision: `"${posture}" applied`
  };
}
