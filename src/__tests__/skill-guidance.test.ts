import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  composeSkillGuidance,
  SKILL_SECTION_SEPARATOR,
  RECOGNIZED_POSTURES
} from '../skills/compose.js';
import { BASE_SKILL } from '../skills/base.js';
import { WEB_SKILL } from '../skills/web.js';
import { LOCAL_SKILL } from '../skills/local.js';
import { WEB_REFERENCE_DEMO_SKILL } from '../skills/web-reference-demo.js';

// The GetPrompt handler itself lives in src/index.ts, which starts a
// transport/server at import time and so cannot be imported here. The
// composition logic is extracted to src/skills/compose.ts (pure) and tested
// directly; the index.ts wiring — including the transport-inference line the
// sprint-154 owner constraint pins verbatim — is guarded by source assertions
// at the bottom of this file.

const SEP = SKILL_SECTION_SEPARATOR;

// Posture-only markers: present in the reference-demo overlay, absent from the
// generic web overlay after the P1 source-of-truth split.
const DEMO_MARKER = 'This is a public demo';
const CTA_MARKER = '[Civic AI Tools CLI](https://github.com/npstorey/civic-ai-tools)';

describe('composeSkillGuidance', () => {
  it('web + SKILL_POSTURE unset -> base + generic web overlay only', () => {
    const c = composeSkillGuidance('web', undefined);
    expect(c.text).toBe(BASE_SKILL + SEP + WEB_SKILL);
    expect(c.text).toContain('# Socrata MCP Skill — Web Overlay');
    expect(c.text).toContain('## Deployment Limits');
    expect(c.text).not.toContain(DEMO_MARKER);
    expect(c.text).not.toContain(CTA_MARKER);
    expect(c.postureApplied).toBe(false);
    expect(c.warning).toBeUndefined();
  });

  it('web + SKILL_POSTURE empty string behaves as unset', () => {
    const c = composeSkillGuidance('web', '');
    expect(c.text).toBe(BASE_SKILL + SEP + WEB_SKILL);
    expect(c.postureApplied).toBe(false);
    expect(c.warning).toBeUndefined();
  });

  it('web + reference-demo -> posture overlay appended after the web overlay', () => {
    const c = composeSkillGuidance('web', 'reference-demo');
    expect(c.text).toBe(BASE_SKILL + SEP + WEB_SKILL + SEP + WEB_REFERENCE_DEMO_SKILL);
    // Appended AFTER the web overlay, separated by the section separator.
    expect(c.text.endsWith(SEP + WEB_REFERENCE_DEMO_SKILL)).toBe(true);
    expect(c.text.indexOf(WEB_SKILL)).toBeLessThan(c.text.indexOf(WEB_REFERENCE_DEMO_SKILL));
    expect(c.text).toContain(DEMO_MARKER);
    expect(c.text).toContain(CTA_MARKER);
    expect(c.postureApplied).toBe(true);
    expect(c.warning).toBeUndefined();
  });

  it('local + reference-demo -> no posture text (posture never applies to local)', () => {
    const c = composeSkillGuidance('local', 'reference-demo');
    expect(c.text).toBe(BASE_SKILL + SEP + LOCAL_SKILL);
    expect(c.text).not.toContain(DEMO_MARKER);
    expect(c.text).not.toContain(CTA_MARKER);
    expect(c.postureApplied).toBe(false);
  });

  it('local + SKILL_POSTURE unset -> base + local overlay (unchanged path)', () => {
    const c = composeSkillGuidance('local', undefined);
    expect(c.text).toBe(BASE_SKILL + SEP + LOCAL_SKILL);
    expect(c.postureApplied).toBe(false);
    expect(c.warning).toBeUndefined();
  });

  it('web + unrecognized posture -> generic composition and a warning naming both values', () => {
    const c = composeSkillGuidance('web', 'bogus');
    expect(c.text).toBe(BASE_SKILL + SEP + WEB_SKILL);
    expect(c.postureApplied).toBe(false);
    expect(c.warning).toBeDefined();
    expect(c.warning).toContain('bogus');
    for (const recognized of RECOGNIZED_POSTURES) {
      expect(c.warning).toContain(recognized);
    }
  });
});

describe('index.ts wiring (source guard)', () => {
  // src/index.ts cannot be imported in tests (it starts a server at import
  // time), so the handler wiring is pinned by source-text assertions. The
  // first is the sprint-154 owner constraint made mechanical: the transport
  // inference must stay exactly as-is.
  const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

  it('explicit modality argument still overrides transport inference (verbatim line present)', () => {
    expect(indexSource).toContain(
      "const modality = args?.modality || (isHttpTransport ? 'web' : 'local');"
    );
  });

  it('handler routes the resolved modality and SKILL_POSTURE through composeSkillGuidance', () => {
    expect(indexSource).toContain('composeSkillGuidance(modality, process.env.SKILL_POSTURE)');
  });

  it('handler surfaces the unrecognized-posture warning via console.error', () => {
    expect(indexSource).toContain('if (composition.warning)');
    expect(indexSource).toContain('console.error(`[Server - GetPrompt] ${composition.warning}`)');
  });
});
