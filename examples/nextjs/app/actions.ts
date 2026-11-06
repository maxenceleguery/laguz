"use server";
import { db, delay, type Status } from "../lib/db";

export async function setStatus(id: string, status: Status) {
  await delay(300);
  const issue = db.issues.find((i) => i.id === id);
  if (!issue) throw new Error(`no issue ${id}`);
  issue.status = status;
}
