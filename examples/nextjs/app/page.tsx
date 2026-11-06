import { boardPage, PAGE } from "../lib/fields";
import { Hydrate } from "../lib/pool";
import { serverPool } from "../lib/server-pool";
import { Board } from "./board";

export default async function Home() {
  const pool = serverPool();
  // The counts are slow, so the browser loads them instead of holding the page.
  await pool.load("issues", boardPage(null, null), PAGE);
  return (
    <Hydrate state={pool.dehydrate()}>
      <Board />
    </Hydrate>
  );
}
