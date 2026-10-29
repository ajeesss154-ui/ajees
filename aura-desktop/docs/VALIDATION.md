# Verification record

## Automated backend checks

47 unit/integration/adversarial tests passed with both:

- Embedded PostgreSQL (PGlite): isolated in-memory databases and a file-backed restart test.
- Standard PostgreSQL 17: actual local container, the same SQL migration and driver used for deployment. The explicit embedded restart test still targets PGlite.

The suite covers password/session handling; session and entity ownership; exact-origin checks including Next's reconstructed internal hostname; production cookie security behind a reverse proxy; bounded bodies; CRUD and project relationships; task due-date changes and completion; actual exactly-once in-app reminder delivery; memory disable controls; dashboard totals independent of preview limits; real PDF/DOCX/TXT extraction and citations; archive expansion rejection; OAuth PKCE/state binding; encrypted credential tamper detection; minimum scopes; official adapter request/error behavior; streamed Gemini/OpenAI test responses; note-to-multiple-task approvals; approval binding, concurrency, expiry and replay; malicious document instructions; conversation API isolation; persistence and migration drift.

Provider and OAuth transports are replaced only in test files; the application has no fake-response provider or fictional connected data.

## Browser acceptance

Both browser acceptance scenarios passed against the production build (`npm start`) on Chromium 156. The Playwright suite runs against the actual Next.js server and actual database. It exercises signup/signin, note creation/edit/search/project assignment, task creation/date edit/completion, document upload/search, saved memory creation/disable, persisted dashboard state, cross-account API rejection, honest missing-AI/Google configuration errors, navigation, desktop and 390 px layouts, command shortcut, theme synchronization and persistence. Test-created accounts are removed after successful completion.

## Commands

```sh
npm ci
npm run db:migrate
npm run typecheck
npm test
npm run build
npm start
# Optional browser test setup:
npx playwright install chromium
npm run test:e2e
```

Migrations were exercised against fresh durable PGlite storage and PostgreSQL. The reminder worker was started against PostgreSQL, delivered a due fixture exactly once, and stopped on Ctrl+C. It correctly refuses a separate process against embedded storage.

The production build compiles all application/API routes. Production dependencies reported no known vulnerabilities in `npm audit --omit=dev` at verification time; this is a dependency advisory check, not a security certification.

## Required workflow mapping

| Requested workflow | Evidence |
| --- | --- |
| Sign in; see only own data | Auth, security and browser suites |
| Save a note; find/summarize it | Browser persistence plus AI engine with test provider and actual retrieval |
| Create task; move due date; complete | Core and browser suites |
| Upload document; ask with source | Actual extraction/retrieval and engine source tests |
| Note to multiple reviewed tasks | AI suite with real DB, pending actions and individual approvals |
| Dashboard uses actual data | Core totals/preview checks plus browser assertions |
| Unavailable integration is honest | Connector and browser tests |
| Cross-user access denied | Service, database constraint and API adversarial checks |
| Untrusted documents cannot authorize tools | Malicious tool/unsolicited write and prior-authorization reuse tests |
| Desktop and narrow layouts | Browser suite across all principal screens |

## Limits of this verification

No live provider key, Google grant or real remote send/calendar mutation was available. Real AI quality, provider quotas, OAuth consent/verification and physical microphone/speaker behavior require an account-backed pilot. Browser tests used Chromium on Linux; the Windows launcher is supplied, but was not executed on a Windows PC during this session. CI definitions include Windows checks, whose results must be checked separately after publication. No claims of certification, full prompt-injection immunity or implemented database RLS are made.
