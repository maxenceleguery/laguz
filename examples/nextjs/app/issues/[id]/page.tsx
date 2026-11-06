import { IssueDetail } from "./issue";

// No prefetch: the components suspend on their queries, the server loads them
// while it renders, and the data streams to the browser with the HTML.
export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IssueDetail id={id} />;
}
