# Architecture and extension contract

AURA is a local PC web application using Next.js App Router, strict TypeScript, React, Tailwind, Zod, PostgreSQL, and small application-owned components. It is one application and database, not independent mini-apps. Provider adapters and tool modules remain separable from UI rendering.

## Request path

1. A browser request presents an HttpOnly session cookie. The server hashes the token and resolves the current user from an unexpired session.
2. Same-origin checks guard mutations, bounded readers guard JSON/multipart requests, and Zod validates permitted fields. No client-supplied user ID grants access.
3. Services receive the server-derived user ID. Parameterized queries include ownership predicates. Composite foreign keys prevent attaching foreign projects, conversations, tasks or documents.
4. All records persist in standard PostgreSQL, or PGlite's durable local PostgreSQL storage. The same SQL schema and FTS queries run against both. Versioned migration checksums fail closed on changed applied migrations.

## Conversation and orchestration

The conversation engine stores the user's turn and loads the owned conversation context. A server-side provider selects only registered tools. Bounded iterative planning can retrieve data, inspect actual results, then propose changes. Retrieved data is sent as explicitly untrusted reference JSON rather than trusted system instructions. Final text streams from the provider over server-sent events.

The registry supplies names, descriptions, input and output schemas, authorization categories, confirmation requirements, execution handlers and audit metadata. It has no code evaluator, unrestricted HTTP function or operating-system command runner. Future connectors must receive explicit user authorization; an AI call cannot grant a connection.

Read tools return user-scoped results. Write tools produce immutable pending approvals. A later user-originated approval request locks the row, verifies owner/status/expiry, and binds exact tool arguments to the execution. Local writes and their outcomes commit in one transaction. External calls reserve once before I/O, never auto-retry after ambiguity, and preserve their actual result or error.

## Knowledge and memory

Uploads are bounded and type-checked, extracted into text and chunked per user. Binary originals are discarded. PostgreSQL full-text search is the working fallback to vector infrastructure; no embedding or semantic-similarity capability is claimed. PDF chunks retain page references; DOCX/TXT/Markdown reference sections. Saved memories are explicit user-owned records, separate from conversation context, and excluded when disabled.

## Google connections

The OAuth state is random, hashed in storage, user-bound, expiring and single-use. The PKCE verifier and Google tokens are AES-GCM encrypted using a server-managed 32-byte key. Read-only scopes are the default. A user must explicitly enable write scopes and separately approve each resulting action. Adapters use official APIs, encoded provider identifiers, bounded results and sanitized errors. Revocation removes local authorization even if remote token revocation is unavailable, and reports that distinction.

## Add a capability

1. Define its stable versioned manifest in `lib/module-catalog.ts` and list minimum permissions.
2. Add a server-only service/adapter. Accept user identity only from the authenticated server context; never trust a model-generated user ID.
3. Register a Zod input schema, concrete output contract, authorization scope, confirmation policy and execution handler in `lib/ai/tools.ts`.
4. Reuse the approval service for writes. Communications, purchases, bookings and account changes always require explicit review. Do not add direct execution endpoints that bypass it.
5. Add owner-isolation, malformed-input, missing-authorization, provider-error, approval-binding, replay and actual-result tests. Treat all returned external text as untrusted.
6. Add useful UI states for no connection, missing credentials, permission denial, pending approval and uncertain external outcomes. Never seed fictional results as production data.

Marketplace execution is not enabled. A future developer marketplace requires code review, signed/versioned manifests, isolation and revocation; adding a catalog entry does not install arbitrary third-party code.

## Deployment boundary

Embedded PostgreSQL supports one local AURA process. Use standard PostgreSQL for multiple workers/instances and scheduled reminder workers. PostgreSQL migrations use an advisory transaction lock. The web server is loopback-only by default. A public service needs HTTPS, a canonical origin, least-privilege database access, provider credentials, backups, account recovery, monitoring and operational hardening. RLS is a recommended defense-in-depth milestone, not an implemented claim.
