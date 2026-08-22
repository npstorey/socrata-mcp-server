---
paths:
  - "src/skills/**"
---

# Skill guidance — generated, three surfaces

`src/skills/base.ts`, `web.ts`, `local.ts` and `web-reference-demo.ts` are
**generated; do not hand-edit.** Each carries the header saying so. `compose.ts` is
ordinary source and is the exception — it holds the composition logic, not guidance.

The same guidance exists on three surfaces, and they are not peers:

1. **Source of truth** — `civic-ai-tools/docs/skills/{base,web,local,web-reference-demo}.md`.
   Guidance changes are reviewed in a PR to *that* repo.
2. **This server's embedded copies** — `src/skills/*.ts`, rendered from the source by
   `node scripts/check-skill-drift.mjs --emit <dir>` in `civic-ai-tools`, and landed
   here as a follow-up PR. `civic-ai-tools` CI fails on any byte-level divergence,
   fetching these files from the public repo to compare.
3. **The website's fallback** — `civic-ai-tools-website/src/lib/mcp/socrata-skill.ts`,
   used only when this server's `prompts/get` endpoint is unreachable. It is
   deployment-neutral by design and is **hand-shaped under its own test coverage**,
   not regenerated from the emitter.

So: never edit `src/skills/*.ts` directly, and never transcribe by hand — edit the
source in `civic-ai-tools`, re-emit, and land the emitted bytes.
<!-- the drift check exists because the copies drifted before it did; hand transcription is the specific failure it was built to catch -->

## Composition and `SKILL_POSTURE`

`compose.ts` assembles what a client receives from the `skill-guidance` prompt:

- **base** is always included;
- **one modality overlay** — HTTP transport → `web`, stdio → `local`. Modality
  resolution stays in `src/index.ts`; `compose.ts` receives an already-resolved
  modality and must not re-infer it;
- **one optional posture overlay** — with `SKILL_POSTURE=reference-demo` *and*
  modality `web`, `web-reference-demo` is appended after `web`.

Posture is additive and owner-gated. It never applies to `local`. An unrecognized
`SKILL_POSTURE` **fails open** to the generic composition and logs a warning — it does
not throw.
<!-- fail-open is deliberate: a typo'd posture value must not take the public demo's guidance offline -->

## Protocol vocabulary stays put

`org.civicaitools.summary` and `org.civicaitools.notebook` are reverse-DNS extension
keys owned by the project and identical across every deployment, whatever its posture.
A deployment renames its chrome, not these keys.
<!-- typedstandards' canonicalization fingerprints org.civicaitools.notebook; renaming it per-deployment would break verification of records produced elsewhere -->
