import {
  execute,
  GraphQLError,
  Kind,
  parse,
  validate,
  visit,
  type ASTNode,
  type DocumentNode,
  type ExecutionResult,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionNode,
  type ValueNode,
} from "graphql";

/** Protocol version announced in `extensions.laguz`. See PROTOCOL.md. */
export const PROTOCOL = 1;

export type ExecuteOptions = {
  schema: GraphQLSchema;
  source: string;
  rootValue?: unknown;
  contextValue?: unknown;
  /** Your server's `execute`, e.g. from envelop or Yoga, to keep its plugins. */
  execute?: typeof execute;
  /** Your server's `validate`. */
  validate?: typeof validate;
};

export type HandlerOptions = Omit<ExecuteOptions, "source" | "contextValue"> & {
  /** Called once per request. Every field of the request shares the returned context. */
  context?: (req: Request) => unknown;
};

function toLiteral(v: unknown): ValueNode {
  if (v === null || v === undefined) return { kind: Kind.NULL };
  if (Array.isArray(v)) return { kind: Kind.LIST, values: v.map(toLiteral) };
  if (typeof v === "object") {
    return {
      kind: Kind.OBJECT,
      fields: Object.entries(v).map(([key, value]) => ({
        kind: Kind.OBJECT_FIELD,
        name: { kind: Kind.NAME, value: key },
        value: toLiteral(value),
      })),
    };
  }
  if (typeof v === "number") {
    return { kind: Number.isInteger(v) ? Kind.INT : Kind.FLOAT, value: String(v) };
  }
  if (typeof v === "boolean") return { kind: Kind.BOOLEAN, value: v };
  return { kind: Kind.STRING, value: String(v) };
}

function failed(
  alias: string | undefined,
  errors: string | readonly GraphQLError[],
): ExecutionResult {
  const list = typeof errors === "string" ? [new GraphQLError(errors)] : errors;
  if (!alias) return { errors: list };
  return {
    data: { [alias]: null },
    errors: list.map((err) => new GraphQLError(err.message, { path: [alias] })),
  };
}

// `$_ref__q0__team__id` reads the value at `q0.team.id`.
function refsIn(node: ASTNode) {
  const refs: { variable: string; alias: string; path: string[] }[] = [];
  visit(node, {
    Variable(v) {
      const [tag, alias, ...path] = v.name.value.split("__");
      if (tag === "_ref" && alias && path.length)
        refs.push({ variable: v.name.value, alias, path });
    },
  });
  return refs;
}

/**
 * Execute each root field of `source` on its own and yield the results in the
 * order they complete. A slow field doesn't delay the others, and an invalid
 * field fails without taking the rest of the query down.
 *
 * A field may take an argument from an earlier field's result
 * (`team(id: $_ref__q0__teamId)`). It runs once that field resolves, with the
 * value substituted, so a chain of dependent queries costs one round trip.
 */
export async function* splitExecute(options: ExecuteOptions): AsyncGenerator<ExecutionResult> {
  let first = true;
  for await (const result of executeFields(options)) {
    // Announces protocol support so clients can start forwarding refs.
    yield first ? { ...result, extensions: { ...result.extensions, laguz: PROTOCOL } } : result;
    first = false;
  }
}

async function* executeFields({
  schema,
  source,
  rootValue,
  contextValue,
  execute: run = execute,
  validate: check = validate,
}: ExecuteOptions): AsyncGenerator<ExecutionResult> {
  let doc: DocumentNode;
  try {
    doc = parse(source);
  } catch (err) {
    yield { errors: [err as GraphQLError] };
    return;
  }

  const op = doc.definitions[0] as OperationDefinitionNode;
  // Only plain queries are split. Mutations, variables and fragments run as one document.
  if (doc.definitions.length !== 1 || op.operation !== "query" || op.variableDefinitions?.length) {
    const errors = check(schema, doc);
    yield errors.length
      ? { errors }
      : await run({ schema, document: doc, rootValue, contextValue });
    return;
  }

  const single = (sel: SelectionNode): DocumentNode => ({
    ...doc,
    definitions: [{ ...op, selectionSet: { ...op.selectionSet, selections: [sel] } }],
  });

  const byAlias = new Map<string, Promise<ExecutionResult>>();
  const fields = op.selectionSet.selections.map((sel) => {
    const alias = sel.kind === Kind.FIELD ? (sel.alias ?? sel.name).value : undefined;
    const refs = refsIn(sel);
    // Looked up before anything is awaited, when only earlier fields are
    // registered: a reference can't point forward, so there are no cycles.
    const deps = refs.map((r) => byAlias.get(r.alias));

    const result = (async (): Promise<ExecutionResult> => {
      let document = single(sel);
      if (refs.length) {
        const values = new Map<string, ValueNode>();
        for (const [i, r] of refs.entries()) {
          const dep = await deps[i];
          const value = r.path.reduce((data: any, key) => data?.[key], dep?.data?.[r.alias]);
          if (value === undefined) {
            return failed(alias, `unresolved reference to ${r.alias}.${r.path.join(".")}`);
          }
          values.set(r.variable, toLiteral(value));
        }
        document = visit(document, { Variable: (v) => values.get(v.name.value) });
      }
      const errors = check(schema, document);
      if (errors.length) return failed(alias, errors);
      return run({ schema, document, rootValue, contextValue });
    })();

    if (alias) byAlias.set(alias, result);
    return result;
  });

  const pending = new Map(fields.map((p, i) => [i, p.then((r) => [i, r] as const)]));
  while (pending.size) {
    const [i, result] = await Promise.race(pending.values());
    pending.delete(i);
    yield result;
  }
}

/** Fold split results back into one standard GraphQL response. */
export async function merged(results: AsyncIterable<ExecutionResult>): Promise<ExecutionResult> {
  const data: Record<string, unknown> = {};
  const errors: GraphQLError[] = [];
  let extensions: Record<string, unknown> | undefined;
  for await (const r of results) {
    Object.assign(data, r.data);
    if (r.errors) errors.push(...r.errors);
    if (r.extensions) extensions = { ...extensions, ...r.extensions };
  }
  return { data, ...(errors.length && { errors }), ...(extensions && { extensions }) };
}

/**
 * A fetch-style handler (Bun, Deno, Cloudflare Workers, Next.js route handlers)
 * for POST `{ query }`. Streams NDJSON when the client accepts it and answers
 * with one merged JSON response otherwise.
 */
export function createHandler(options: HandlerOptions) {
  return async (req: Request): Promise<Response> => {
    const { query } = (await req.json()) as { query: string };
    const results = splitExecute({
      ...options,
      source: query,
      contextValue: options.context?.(req),
    });
    if (req.headers.get("accept")?.includes("application/x-ndjson")) return ndjson(results);
    return Response.json(await merged(results));
  };
}

/**
 * Stream results as newline-delimited JSON. If you compress the response,
 * flush the compressor after each line, or the stream arrives all at once.
 */
export function ndjson(results: AsyncIterable<unknown>): Response {
  const it = results[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

const nextTask: (fn: () => void) => void =
  (globalThis as { setImmediate?: (fn: () => void) => void }).setImmediate ??
  ((fn) => setTimeout(fn, 0));

/**
 * A minimal DataLoader: keys requested in the same tick are passed to `batch`
 * together, and each key is loaded once. Create one per request (in `context`)
 * so all the fields of a request share it.
 */
export function batchLoader<K, V>(batch: (keys: K[]) => Promise<V[]>) {
  let queue: { key: K; resolve: (v: V) => void; reject: (err: unknown) => void }[] = [];
  const cache = new Map<K, Promise<V>>();

  function dispatch() {
    const jobs = queue;
    queue = [];
    batch(jobs.map((job) => job.key)).then(
      (values) => jobs.forEach((job, i) => job.resolve(values[i]!)),
      (err) => jobs.forEach((job) => job.reject(err)),
    );
  }

  return (key: K): Promise<V> => {
    const cached = cache.get(key);
    if (cached) return cached;
    const promise = new Promise<V>((resolve, reject) => queue.push({ key, resolve, reject }));
    cache.set(key, promise);
    if (queue.length === 1) nextTask(dispatch);
    return promise;
  };
}
