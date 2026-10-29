import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const password = "AURA acceptance test 2026";
async function signup(page: Page, name = "Acceptance user") {
  const email = `e2e-${randomUUID()}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create your workspace" }).click();
  await page.waitForURL("**/home");
  await expect(
    page.getByRole("heading", {
      name: new RegExp(`Good .*${name.split(" ")[0]}`),
    }),
  ).toBeVisible();
  return email;
}
async function deleteAccount(page: Page) {
  const r = await page.request.delete("/api/settings", {
    data: { password, confirmation: "DELETE MY ACCOUNT" },
  });
  expect(r.ok()).toBeTruthy();
}
test("PC account, notes, tasks, documents, memory, dashboard and owner isolation use actual APIs", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const email = await signup(page);
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("Launch research");
  await page.getByLabel("What’s the goal?").fill("Build a useful assistant");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const noteDialog = page.getByRole("dialog");
  await noteDialog
    .getByLabel("Title", { exact: true })
    .fill("Helios study notes");
  await noteDialog
    .getByLabel("Your note")
    .fill(
      "The Helios launch deadline is November 20. Read the orbital mechanics chapter and prepare a revision plan.",
    );
  await noteDialog
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption({ label: "Launch research" });
  await noteDialog
    .getByLabel("Tags, separated by commas")
    .fill("study, launch");
  const noteSaved = page.waitForResponse(
    (r) => r.url().endsWith("/api/notes") && r.request().method() === "POST",
  );
  await noteDialog
    .getByRole("button", { name: "Save note", exact: true })
    .click();
  const note = (await (await noteSaved).json()).item;
  await expect(
    page.getByRole("heading", { name: "Helios study notes", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Helios study notes" }),
  ).toBeVisible();
  await page
    .locator(".note-card")
    .filter({ hasText: "Helios study notes" })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Your note")
    .fill(
      "The Helios launch deadline is November 21. Review orbital mechanics.",
    );
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByLabel("Search notes").fill("orbital");
  await expect(
    page.getByRole("heading", { name: "Helios study notes" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const taskDialog = page.getByRole("dialog");
  await taskDialog
    .getByLabel("What needs to get done?")
    .fill("Review orbital mechanics");
  await taskDialog
    .getByRole("combobox", { name: "Priority", exact: true })
    .selectOption("high");
  await taskDialog.getByLabel("Due date").fill("2030-11-20T15:00");
  await taskDialog.getByLabel("Remind me").fill("2020-01-01T12:00");
  await taskDialog
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption({ label: "Launch research" });
  await taskDialog.getByRole("button", { name: "Save task" }).click();
  await expect(
    page.getByRole("button", { name: "Review orbital mechanics", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review orbital mechanics", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Due date")
    .fill("2030-11-21T15:00");
  await page.getByRole("button", { name: "Save task" }).click();
  await page
    .getByRole("button", {
      name: "Complete Review orbital mechanics",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: /^Completed/ }).click();
  await expect(
    page.getByRole("button", { name: "Reopen Review orbital mechanics" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "helios-guide.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "The Helios launch deadline is November 21. The telescope aperture is 42 centimetres.",
    ),
  });
  await expect(page.getByText("helios-guide", { exact: true })).toBeVisible();
  const docs = await (await page.request.get("/api/documents")).json();
  expect(docs.items).toHaveLength(1);
  const hits = await (
    await page.request.get("/api/documents/search?q=Helios")
  ).json();
  expect(JSON.stringify(hits)).toContain("helios-guide");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Add memory" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Title", { exact: true })
    .fill("Learning preference");
  await page
    .getByRole("dialog")
    .getByLabel("Memory", { exact: true })
    .fill("I prefer short examples.");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(
    page.getByText("I prefer short examples.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("switch", { name: "Use long-term memory" }).click();
  await expect(
    page.getByRole("switch", { name: "Use long-term memory" }),
  ).toHaveAttribute("aria-checked", "false");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(
    page.getByText("Helios study notes", { exact: true }),
  ).toBeVisible();
  const dashboard = await (await page.request.get("/api/dashboard")).json();
  expect(dashboard.stats.completed_tasks).toBe(1);
  expect(dashboard.stats.total_notes).toBe(1);
  const other = await browser.newContext();
  const second = await other.newPage();
  await signup(second, "Second person");
  expect(
    (await (await second.request.get("/api/notes")).json()).items,
  ).toHaveLength(0);
  expect((await second.request.get(`/api/notes/${note.id}`)).status()).toBe(
    404,
  );
  expect(
    (await second.request.get(`/api/documents/${docs.items[0].id}`)).status(),
  ).toBe(404);
  await deleteAccount(second);
  await other.close();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/home");
  expect(errors).toEqual([]);
  await deleteAccount(page);
});
test("unconfigured AI and Google services return honest errors; desktop and narrow layouts stay usable", async ({
  page,
}) => {
  await signup(page, "Layout reviewer");
  await page.getByRole("link", { name: /^AI Assistant/ }).click();
  await page.getByLabel("Message AURA").fill("Hello, can you plan my day?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".error-banner[role=alert]")).toContainText(
    "AI is not configured",
  );
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByText("Setup required")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Connect Google Calendar", exact: true })
    .click();
  await expect(page.locator(".error-banner[role=alert]")).toContainText(
    "not configured",
  );
  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(
    page.getByText("Bring your calendar into the picture.", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    "home",
    "assistant",
    "notes",
    "tasks",
    "knowledge",
    "connections",
    "settings",
    "roadmap",
  ]) {
    await page.goto("/" + route);
    await expect(page.locator(".main-content")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBeTruthy();
  }
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("Ask the assistant")).toBeFocused();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: "Use light theme" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Appearance" })
    .selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Use light theme" }),
  ).toBeVisible();
  await deleteAccount(page);
});
