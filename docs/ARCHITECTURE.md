# Architecture

Personal Commentary is a single-user Mac application: a React UI served by a Fastify server on loopback, local SQLite storage, external reference sources, and the OpenAI Responses API.

```text
React interface ── HTTP + server-sent events ── Fastify
                                                  │
                     ┌────────────────────────────┼───────────────────────┐
                     ▼                            ▼                       ▼
                Local SQLite              Reference library       Network requests
            studies and revisions       Bible and lexical data    sources and OpenAI
```

## Research flow

1. Parse the passage reference and load its Bible text from the downloaded library.
2. Gather commentary, cross-references, Hebrew or Greek word data, and preferred sources. Gathering stages run concurrently and report gaps when a source is unavailable.
3. Give evidence excerpts stable run-local identifiers. Separate structured model calls produce the sections of the study brief.
4. Verify quoted wording against full stored source text. Failed quotation matches lose quotation marks; relationship checks can downgrade unsupported labels.
5. Store verified cards with provenance and stream progress to the UI. Interrupted runs become failed on restart instead of appearing complete.

Key modules: [pipeline](../server/pipeline.ts), [gatherers](../server/sources/gatherers.ts), [voice sources](../server/sources/voices.ts), [prompts](../server/prompts.ts), [verification](../server/verify.ts).

Word definitions and usage examples come from indexed source data rather than generated definitions. A quotation match establishes textual correspondence, not the truth of a claim or the correctness of its interpretation.

## Research and writing use different inputs

Research inputs contain the passage, sources, and a versioned editorial profile. They exclude personal notes, writing voice, and personal theological preferences. Compatibility keys and input fingerprints prevent reuse across mismatched research profiles or known source versions.

Drafting can use notes, highlighted research, existing pieces, and writing preferences. Notes are optional when there is research or another piece to draw from. Requests wait for pending notes to save; conflict detection prevents an older save from silently replacing newer working text. Each writing form retains its own drafts and revisions.

These personal writing inputs are sent to OpenAI when using live drafting or review. Local storage and cloud inference are separate boundaries.

Key modules: [research profiles](../server/research-profile.ts), [writing](../server/writing.ts), [autosave](../web/src/autosave.ts), [writing state](../web/src/study/useWriting.ts).

## Review and sharing

Deterministic checks identify issues such as unsupported quotations, placeholders, character limits, and known attribution problems. Model review supplies additional judgments for a reader to resolve.

The publishing gate requires a review of the exact current text hash. Editing text makes an earlier review stale. Publishing creates local post records and opens X's composer; the user completes posting and can record the resulting URL. The app does not silently publish a model draft.

Key modules: [review](../server/review.ts), [publish gate](../server/publish.ts), [sharing interface](../web/src/components/PublishFlow.tsx).

## Model transport

Calls go through [llm.ts](../server/llm.ts), with strict structured-output schemas, explicit reasoning settings, response storage disabled, and budget checks. The cost ledger records calls and estimated usage. Configured models live in [config.ts](../server/config.ts); availability and provider prices can change, so verify them for a live installation.

Fixture-based tests prove parsing, gates, recovery, and data boundaries. They do not prove current model quality, live website availability, latency, or cost.

## Local server boundary

- The server listens only on `127.0.0.1`.
- Host checks reject unexpected hosts. Writes require the app origin and a random per-process capability token.
- The server injects the capability into the served page; use the Fastify URL rather than a separate Vite development origin.
- The API key is held in macOS Keychain and is not sent to the frontend.
- Outbound source requests pass through fetch policies, body limits, caching, and rate limits.

This is one user's local application, not a multi-user hosted service. The application does not encrypt its database; device permissions, backups, and cloud-folder settings still matter.

## Storage and export

Application data includes the SQLite database, reference datasets, cached source bodies, and database backups. The default root is `~/Library/Application Support/PersonalCommentary/`; logs are under `~/Library/Logs/PersonalCommentary/`. Human-readable study records are written under `~/Documents/Personal Commentary/`.

The research corpus has its own curation boundary. An input classified as neutral is not automatically approved for release. Export checks inspect privacy, quality, evidence dependencies, provenance, and redistribution rights. Typed projections exclude private study fields and raw model requests/responses. Changes to evidence can invalidate an earlier approval.

The public source tree contains local corpus inspection and export code. No hosted database deployment or synchronization service is configured here.

Key modules: [database](../server/db.ts), [backups](../server/backup.ts), [study exports](../server/research-export.ts), [research corpus](../server/research-corpus.ts).

## Tests

Unit suites run against temporary application directories. The daily-loop integration scenario requires an explicitly configured downloaded dataset directory and replays model and web-source fixtures. Its checks include quotation verification, private-input exclusion, budget enforcement, changed-text review invalidation, and interrupted-run recovery.

See [the README](../README.md#verify) for commands and [fixture notes](../tests/fixtures/README.md) for the synthetic source material used in tests.
