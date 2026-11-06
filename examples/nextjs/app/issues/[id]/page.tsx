import { ISSUE, MORE, moreFrom } from "../../../lib/fields";
import { Hydrate } from "../../../lib/pool";
import { serverPool } from "../../../lib/server-pool";
import { IssueDetail } from "./issue";

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pool = serverPool();
  // `moreFrom` reads the assignee from the issue, and both still run in one batch.
  await Promise.all([pool.load("issue", { id }, ISSUE), pool.load("issues", moreFrom(id), MORE)]);
  return (
    <Hydrate state={pool.dehydrate()}>
      <IssueDetail id={id} />
    </Hydrate>
  );
}
