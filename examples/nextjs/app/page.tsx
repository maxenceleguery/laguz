import { issuePage } from "../lib/queries";
import { Hydrate } from "../lib/pool";
import { serverPool } from "../lib/server-pool";
import { Board } from "./board";

export default async function Home() {
  const pool = serverPool();
  // The counts are slow, so the browser loads them instead of holding the page.
  await pool.load(issuePage(null, null));
  return (
    <Hydrate state={pool.dehydrate()}>
      <Board />
    </Hydrate>
  );
}
