# Documents and Google connections

The PC application starts without Google credentials. Connections and Calendar show configuration or authorization errors until a real account is connected. Tests use injected HTTP responses; no Google account was connected during development.

## Google OAuth setup

1. Create a Google Cloud project, enable Google Calendar API and Gmail API, and configure an OAuth consent screen. For an external app in testing, add the Google accounts that will test it.
2. Create a **Web application** OAuth client. Register the exact `GOOGLE_REDIRECT_URI`, for example `http://127.0.0.1:3000/api/oauth/google/callback` during local development. Production callback URLs must use HTTPS. `localhost` and `127.0.0.1` are different redirect origins.
3. Configure these server variables and restart the application:

   ```dotenv
   GOOGLE_CLIENT_ID=
   GOOGLE_CLIENT_SECRET=
   GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/api/oauth/google/callback
   INTEGRATION_ENCRYPTION_KEY=
   ```

   Generate an encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Keep the key stable, private, and backed up separately from the database. Changing it makes existing encrypted credentials unreadable; reconnecting is required. A managed key rotation workflow is a future milestone.

4. Sign in to AURA, open Connections, and authorize the desired service. Initial connections request read access. Request write access separately when you want calendar changes, email drafts, or email sending. Each actual write still requires review of its exact arguments and a one-time approval in the assistant.

Google may require OAuth app verification, restricted-scope review, and additional provider requirements before public Gmail access is available. Enabling a Cloud API or having a Gemini key does not grant Gmail or Calendar access.

## Scopes

| Connection | Read access | Additional write access |
| --- | --- | --- |
| Google Calendar | `calendar.events.readonly`, `calendar.freebusy` | replaces `calendar.events.readonly` with `calendar.events` |
| Gmail | `gmail.readonly` | adds `gmail.compose`, which permits draft creation and sending |

The application does not request Google passwords, a full Google Drive scope, or unrestricted account access. OAuth uses PKCE and a user-bound, hashed, expiring, single-use state. Access/refresh tokens and PKCE verifiers use authenticated AES-256-GCM encryption at rest.

Disconnect always deletes local credentials and pending OAuth attempts. It also attempts official provider token revocation. If Google is unreachable, local access is still removed and the result reports `revoked: false`; users can also revoke access through their Google account. Google grant revocation can affect another connection authorized through the same OAuth client, which may need reconnection.

## Tool adapters

`lib/connectors/google.ts` exposes injected-HTTP Calendar and Gmail adapters and `executeConnectorTool(userId, name, input, {approvalId})`. Sensitive operations require an owned, unexpired approval in the `executing` state with an exact match of tool name and immutable arguments. This complements the central orchestration approval state machine; there are no public unauthenticated send or calendar-write endpoints.

Read tools return actual provider responses or honest errors. Gmail content is bounded and converted to readable text; attachments and active HTML are not forwarded as executable content. Provider timeouts during writes produce an uncertain-result error that asks users to check the provider before retrying.

## Document handling

PDF, UTF-8 TXT/Markdown, and DOCX uploads are limited to 5 MB, 500,000 extracted characters, and 300 PDF pages. Multipart bodies are bounded while reading. Office ZIP structures and actual decompression are checked before extraction, with a 20 MB expansion ceiling. Images/scanned PDFs without text and encrypted documents need a readable text version; OCR is not implemented.

Only extracted text is stored; originals are not publicly served. Chunks carry page or section references and use PostgreSQL full-text search with a substring fallback. Search joins both document ID and owner ID. Notes and saved memories are included under the same owner scope; disabling long-term memory excludes saved memories from retrieval.

Uploaded content remains untrusted reference material. It cannot authorize tools or replace system instructions. All assistant mutations require an independent user approval. Large-scale production ingestion should move parsing to isolated worker processes with resource/time budgets and add malware scanning and operational monitoring before accepting arbitrary public uploads.
