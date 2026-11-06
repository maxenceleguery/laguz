// In-memory data. Every call waits like a database round trip would, so
// batching and streaming are visible in the browser.
export type Status = "OPEN" | "DONE";
export type User = { id: string; name: string; email: string };
export type Issue = {
  id: string;
  title: string;
  status: Status;
  assigneeId: string;
  createdAt: string;
};

const users: User[] = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson"].map(
  (name, i) => ({
    id: `u${i + 1}`,
    name,
    email: `${name.split(" ")[0]!.toLowerCase()}@example.com`,
  }),
);

const titles = [
  "Search ignores accents",
  "Export to CSV drops the last row",
  "Dark mode contrast on badges",
  "Retry uploads after a network error",
  "Keyboard shortcut for new issue",
  "Timezone shown in due dates",
  "Paste images into comments",
  "Slow board with 500 issues",
  "Remember the last filter",
  "Notification emails are sent twice",
  "Archive closed projects",
  "Mention autocomplete is case sensitive",
  "Sort by last update",
  "Broken link in the invite email",
  "Show who changed the status",
  "Bulk edit labels",
  "Offline banner never disappears",
  "Avatar upload rejects PNG",
  "Board scroll jumps after an update",
  "Add an API token page",
  "Markdown tables in descriptions",
  "Due date reminders",
  "Weekly summary email",
  "Duplicate issue detection",
];

const issues: Issue[] = titles.map((title, i) => ({
  id: String(titles.length - i),
  title,
  status: i % 3 === 2 ? "DONE" : "OPEN",
  assigneeId: users[i % users.length]!.id,
  createdAt: new Date(Date.UTC(2026, 9, 1 + titles.length - i)).toISOString(),
}));

// Next.js reloads modules in development: keep the data on globalThis.
const g = globalThis as { trackerDb?: { users: User[]; issues: Issue[] } };
export const db = (g.trackerDb ??= { users, issues });

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
