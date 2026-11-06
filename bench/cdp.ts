// Minimal Chrome DevTools Protocol client (flattened sessions).
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

type Msg = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
};

export async function launch(dataDir: string, flags: string[] = []) {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const proc = Bun.spawn(
    [
      "chromium",
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${dataDir}`,
      "--remote-debugging-port=0",
      ...flags,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const portFile = `${dataDir}/DevToolsActivePort`;
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(100);
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));

  let id = 0;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const listeners = new Set<(m: Msg) => void>();
  ws.onmessage = (e) => {
    const m: Msg = JSON.parse(e.data as string);
    const p = m.id !== undefined ? pending.get(m.id) : undefined;
    if (!p) {
      listeners.forEach((l) => l(m));
      return;
    }
    pending.delete(m.id!);
    if (m.error) p.fail(new Error(m.error.message));
    else p.ok(m.result);
  };
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((ok, fail) => {
      pending.set(++id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  return {
    send,
    on: (l: (m: Msg) => void) => (listeners.add(l), () => void listeners.delete(l)),
    /** New tab with its own session; `s` sends to it, `once` awaits one of its events. */
    async tab() {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method: string, params: object = {}) => send(method, params, sessionId);
      const once = (method: string) =>
        new Promise<any>((r) => {
          const off = this.on(
            (m) => m.sessionId === sessionId && m.method === method && (off(), r(m.params)),
          );
        });
      const evaluate = async (expression: string) => {
        const { result, exceptionDetails } = await s("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (exceptionDetails)
          throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      };
      return {
        sessionId,
        s,
        once,
        evaluate,
        close: () => send("Target.closeTarget", { targetId }),
      };
    },
    close() {
      ws.close();
      proc.kill();
    },
  };
}
