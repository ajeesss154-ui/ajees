# Assistant orchestration and trust boundaries

AURA uses an existing foundation model; it does not train a new model. Gemini is the default provider, preserving the existing project's free-tier-first approach. OpenAI is also supported. Usage quotas, pricing and provider data policies depend on the configured account.

## Configuration

Set `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, and optionally `GEMINI_MODEL` (default `gemini-3.8-flash`), or `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally `OPENAI_MODEL` (default `gpt-4.1-mini`). These settings remain on the PC server. API keys are not returned by the status endpoint or included in browser bundles. A paid chat subscription does not supply an API key.

With no configured key, notes, tasks, documents, saved memory and dashboard still work. Chat returns a configuration error instead of inventing an AI response. The authenticated `/api/ai/status` endpoint reports the provider, model and configuration status only.

## Conversation pipeline

1. The session identifies the user; a client cannot choose a different owner.
2. A user message and its conversation are persisted.
3. A bounded planner selects registered native function calls. Gemini uses function declarations with JSON Schema; OpenAI uses function tools. Every input is validated again by the server.
4. Read tools use owner-scoped services. A maximum of eight calls across four planning rounds prevents unbounded loops. The current server time and the user's configured time zone are supplied for scheduling requests.
5. Write calls create immutable, fifteen-minute approval records. No action executes at this stage. The latest user message must also request an action; retrieved text cannot supply that authorization.
6. A final answer streams through the provider's actual SSE endpoint. Retrieved source references accompany the answer and remain attached to the saved message.

Provider failures are sanitized. Partial answers are marked as interrupted in persistent history. Stopping the response cancels its provider request. Provider requests and real-time browser speech need internet access to their respective services.

## Approvals and actual execution

Each approval displays the tool and exact validated arguments. Approval or rejection requires an authenticated, same-origin request. Only the owner may decide, and an approval can be used once. The execution boundary verifies the owner, conversation, tool, canonical input and executing status against the stored grant; an arbitrary approval ID cannot authorize a write.

Internal workspace actions, execution records and the final approval status commit in one database transaction. Failures roll the write back and persist a failure outcome. Emails and calendar changes use official provider APIs after a committed one-use reservation; external APIs cannot join a PostgreSQL transaction. A crash can leave an action `executing`, and a network failure may leave its external outcome uncertain. AURA never automatically retries that approval: check the provider before proposing a new action. This avoids duplicate sends or events but is not an exactly-once guarantee across external systems.

All consequential tools require separate review. There is no broad autonomous permission, shell tool, arbitrary code evaluator or unrestricted filesystem tool. The PC web application does not inherit the older JARVIS application's operating system control.

## Untrusted knowledge

Notes, memories, uploaded documents and connected emails are reference data, not system instructions. Tool results are explicitly marked as untrusted in both planner and answer prompts. Document text cannot grant new permissions. The registry accepts only known tools with strict schemas, while server authorization and approvals enforce the actual boundary. These defenses reduce prompt injection risk; they do not claim that a foundation model is immune to malicious instructions.

Memory is explicitly saved and can be disabled, edited and deleted. Disabled memory is excluded from retrieval. Previously shared material can still exist in conversation history until that history is deleted. PostgreSQL full-text search is the practical retrieval fallback in this version; embedding/vector retrieval is a future adapter.

## Verification

`tests/ai.test.ts` uses mocked official-provider HTTP responses and a real embedded PostgreSQL instance to verify both provider streams, tool planning, note retrieval, cited document answers, proposed note-to-task workflows, approval execution and rejected document-origin writes. `tests/security.test.ts` adds forged-grant, ownership, replay, rejection, expiration and concurrent-execution cases. Tests do not establish that a user's API key or Google OAuth configuration is valid; live account validation requires those credentials.

Model selection was checked against Google’s current [model catalog](https://ai.google.dev/gemini-api/docs/models) and [pricing](https://ai.google.dev/gemini-api/docs/pricing). The default uses Gemini 3.8 Flash; free-tier eligibility and quotas depend on your account. Free-tier content may be used to improve Google products under its terms. Choose the appropriate provider/tier before sending sensitive information.
