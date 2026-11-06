"use client";
import { LaguzDevtools } from "@laguzjs/client/devtools";
import { viewer } from "../lib/queries";
import { useData, usePool } from "../lib/pool";

export function Viewer() {
  const { data } = useData(viewer);
  return <span>{data?.name}</span>;
}

/** Each request the browser sends, when each field arrived, and the cache. */
export function Devtools() {
  return <LaguzDevtools pool={usePool()} initialOpen />;
}
