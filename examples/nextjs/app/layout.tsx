import Link from "next/link";
import type { ReactNode } from "react";
import { viewer } from "../lib/queries";
import { Hydrate, PoolProvider } from "../lib/pool";
import { serverPool } from "../lib/server-pool";
import { Devtools, Viewer } from "./shell";
import "./globals.css";

export const metadata = { title: "Tracker, a laguz example" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const pool = serverPool();
  await pool.load(viewer);
  return (
    <html lang="en">
      <body>
        <PoolProvider>
          <Hydrate state={pool.dehydrate()}>
            <header>
              <Link href="/">Tracker</Link>
              <Viewer />
            </header>
            <main>{children}</main>
            <Devtools />
          </Hydrate>
        </PoolProvider>
      </body>
    </html>
  );
}
