# AURA PC implementation plan

## Existing repository inspection
The repository contains the CC BY-NC licensed FatihMakes PyQt6/Python JARVIS desktop application and an independent MIT Android/FastAPI prototype. Desktop settings are single-user files with SQLite workspace data; mobile auth is a shared bearer token and chat is not persisted. Neither has a web account model, multi-user authorization, or a suitable production web schema. Existing projects remain intact. The new commercial-oriented foundation does not copy noncommercial JARVIS source.

## Implementation
1. Add an independent strict TypeScript Next.js App Router application in aura-desktop, retaining the rest of the repository. Use a small reusable component system, Tailwind, and original desktop-first design.
2. Implement password authentication, hashed sessions, PostgreSQL migrations and ownership constraints. Use durable embedded PostgreSQL (PGlite) for zero-Docker local setup and standard PostgreSQL via DATABASE_URL for deployment.
3. Add real notes, tasks, projects, reminders, controlled memory, document extraction and PostgreSQL full-text retrieval. No seeded user content or fake success.
4. Reuse the Gemini/OpenAI provider concept through server-only TypeScript adapters. Add persisted chat, structured validated tools, proposed-write approvals, audit history, and streamed transport.
5. Add Google OAuth interfaces and real API adapters gated by credentials, browser voice, honest connection statuses, and explicit roadmap pages.
6. Test ownership, workflow approvals, retrieval, provider failures, document prompt injection boundaries, desktop/mobile layouts, and build the production application.

## Trust boundaries
Tools receive server-derived user identity. Retrieved content is untrusted data. All assistant writes require review. Only validated registered tools execute; no arbitrary shell/code tool. Provider credentials stay server-side. No operating system access is inherited from the older desktop application.
