import { expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPool, httpFetcher, ref } from "@laguzjs/client";
import { GraphQLError } from "graphql";
import { createSchema, createYoga, type Plugin } from "graphql-yoga";
import { toNodeHandler } from "./node.ts";
import { createHandler, ndjson, useLaguz } from "./server.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    teamId: ID!
  }
  type Team {
    name: String!
  }
  type Query {
    slow: Int!
    fast: Int!
    user(id: ID!): User
    team(id: ID!): Team
    whoami: String
    boom: Int
    denied: Int
  }
`;
let slowGate: Promise<void> = Promise.resolve();
const resolvers = {
  Query: {
    slow: () => slowGate.then(() => 1),
    fast: () => 2,
    user: (_: unknown, { id }: { id: string }) => ({ id, teamId: `t${id}` }),
    team: (_: unknown, { id }: { id: string }) => ({ name: `team ${id}` }),
    whoami: (_: unknown, __: unknown, ctx: { user?: string }) => ctx.user ?? null,
    boom: () => {
      throw new Error("database password is hunter2");
    },
    denied: () => {
      throw new GraphQLError("Not allowed");
    },
  },
};

function yoga(plugins: Plugin[] = []) {
  return createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    context: ({ request }): { user?: string } => ({
      user: request.headers.get("x-user") ?? undefined,
    }),
    plugins: [useLaguz(), ...plugins],
    logging: false,
  });
}
const post = (query: string, accept: string, headers: Record<string, string> = {}) =>
  new Request("http://x/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", accept, ...headers },
    body: JSON.stringify({ query }),
  });
const lines = async (res: Response) =>
  (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

// --- Yoga ---

test("Yoga: a streaming batch arrives field by field, refs forwarded, in Yoga's context", async () => {
  const gate = deferred();
  slowGate = gate.promise;
  const res = await yoga().fetch(
    post(
      "{ q0: slow q1: fast q2: user(id: 1) { teamId } q3: team(id: $_ref__q2__teamId) { name } q4: whoami }",
      "application/x-ndjson",
      { "x-user": "ada" },
    ),
  );
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  gate.resolve();
  const out = await lines(res);
  expect(out[0].extensions).toEqual({ laguz: 1 });
  const order = out.map((line) => Object.keys(line.data)[0]);
  expect(order.at(-1)).toBe("q0"); // the slow field doesn't hold the others back
  const data = Object.assign({}, ...out.map((line) => line.data));
  expect(data).toEqual({
    q0: 1,
    q1: 2,
    q2: { teamId: "t1" },
    q3: { name: "team t1" },
    q4: "ada",
  });
});

test("Yoga: its masked errors and its plugins still apply", async () => {
  let executions = 0;
  let validations = 0;
  const counting: Plugin = {
    onExecute: () => void executions++,
    onValidate: () => void validations++,
  };
  const out = await lines(
    await yoga([counting]).fetch(post("{ q0: boom q1: denied q2: fast }", "application/x-ndjson")),
  );
  const errors = Object.fromEntries(
    out
      .filter((line) => line.errors)
      .map((line) => [line.errors[0].path[0], line.errors[0].message]),
  );
  expect(errors).toEqual({ q0: "Unexpected error.", q1: "Not allowed" });
  expect(JSON.stringify(out)).not.toContain("hunter2");
  expect(executions).toBe(3); // one execution per field, each through Yoga's plugins
  expect(validations).toBeGreaterThan(0); // and Yoga's validation
});

test("Yoga: other requests are left alone; JSON batches with refs are resolved", async () => {
  const plain = (await (await yoga().fetch(post("{ fast }", "application/json"))).json()) as any;
  expect(plain).toEqual({ data: { fast: 2 } });

  const refs = (await (
    await yoga().fetch(
      post(
        "{ q0: user(id: 2) { teamId } q1: team(id: $_ref__q0__teamId) { name } }",
        "application/json",
      ),
    )
  ).json()) as any;
  expect(refs.data).toEqual({ q0: { teamId: "t2" }, q1: { name: "team t2" } });
});

test("Yoga: a laguz pool gets a dependent chain in one request", async () => {
  slowGate = Promise.resolve();
  const server = yoga();
  let requests = 0;
  const http = httpFetcher("http://x/graphql", {
    stream: true,
    fetch: server.fetch as typeof fetch,
  });
  const pool = createPool((query, options) => (requests++, http(query, options)), {
    serverRefs: "auto",
  });
  await pool.load("fast", {}, []); // the first response tells the pool the server forwards refs
  const team = { id: ref("user", { id: 3 }, "teamId") };
  await pool.load("team", team, ["name"]);
  expect(pool.read("team", team).data).toEqual({ name: "team t3" });
  expect(requests).toBe(2);
});

// --- Node ---

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown) {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://localhost:${port}/graphql`, close: () => server.close() };
}

const schemaHandler = () =>
  createHandler({
    schema: yoga().getEnveloped({}).schema,
    rootValue: undefined,
  });

test("Node: results stream out one by one, not when the response is complete", async () => {
  const gate = deferred();
  slowGate = gate.promise;
  const server = await listen(toNodeHandler(schemaHandler()));
  try {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ query: "{ q0: slow q1: fast }" }),
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    // `slow` waits for this test: a buffered response would never arrive.
    const first = await reader.read();
    expect(JSON.parse(first.value!.split("\n")[0]!).data).toEqual({ q1: 2 });
    gate.resolve();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += r.value;
    expect(rest).toContain('"q0":1');
  } finally {
    server.close();
  }
});

test("Node: a body an Express parser already read is used", async () => {
  slowGate = Promise.resolve();
  const handler = toNodeHandler(schemaHandler());
  const server = await listen(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    Object.assign(req, { body: JSON.parse(text) }); // what express.json() does
    return handler(req, res);
  });
  try {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ q0: fast }" }),
    });
    expect(((await res.json()) as any).data).toEqual({ q0: 2 });
  } finally {
    server.close();
  }
});

test("Node: when the client goes away, the results are closed", async () => {
  const closed = deferred();
  // Endless: only the client leaving can stop it. An async generator closes at
  // its next `yield`, so cancelling takes effect when the next result is ready.
  async function* results() {
    try {
      for (let i = 0; ; i++) {
        yield { data: { [`q${i}`]: i } };
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      closed.resolve();
    }
  }
  const server = await listen(toNodeHandler(async () => ndjson(results())));
  try {
    const abort = new AbortController();
    const res = await fetch(server.url, { method: "POST", body: "{}", signal: abort.signal });
    await res.body!.getReader().read();
    abort.abort();
    await closed.promise; // times out if the stream is left suspended
  } finally {
    server.close();
  }
});
