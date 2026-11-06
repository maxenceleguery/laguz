import {
  astFromValue,
  execute,
  GraphQLError,
  Kind,
  parse,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type ASTNode,
  type DocumentNode,
  type ExecutionResult,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionNode,
  type ValueNode,
} from "graphql";

export { generateTypes, type TypesOptions } from "./codegen.ts";

/** Protocol version announced in `extensions.laguz`. See PROTOCOL.md. */
export const PROTOCOL = 1;

export type ExecuteOptions = {
  schema: GraphQLSchema;
  source: string;
  rootValue?: unknown;
  contextValue?: unknown;
  /** Variables of a document that declares them. Batches from the pool have none. */
  variableValues?: Record<string, unknown> | null;
  /** The operation to run in a document with several. */
  operationName?: string | null;
  /** Your server's `execute`, e.g. from envelop or Yoga, to keep its plugins. */
  execute?: typeof execute;
  /** Your server's `validate`. */
  validate?: typeof validate;
};

export type HandlerOptions = Omit<
  ExecuteOptions,
  "source" | "contextValue" | "variableValues" | "operationName"
> & {
  /** Called once per request. Every field of the request shares the returned context. */
  context?: (req: Request) => unknown;
};

export type LocalOptions = Omit<
  ExecuteOptions,
  "source" | "contextValue" | "variableValues" | "operationName"
> & {
  /** Called once per batch. Every field of the batch shares the returned context. */
  context?: () => unknown;
};

/**
 * A fetcher for `createPool` that runs queries in-process against `schema`,
 * without HTTP: in tests and stories, or in server components when the schema
 * lives in the same app. Execution is the server's, so a selection the schema
 * rejects fails the way it would in production.
 */
export function localFetcher(options: LocalOptions) {
  return (source: string): AsyncIterable<ExecutionResult> =>
    splitExecute({ ...options, source, contextValue: options.context?.() });
}

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

const toGraphQLError = (err: unknown) =>
  err instanceof GraphQLError
    ? err
    : new GraphQLError(err instanceof Error ? err.message : String(err));

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

const CACHE_SIZE = 500;
type Prepared = {
  doc: DocumentNode;
  errors: readonly GraphQLError[];
  /** Placeholders per root field, computed on first use. */
  refs?: ReturnType<typeof refsIn>[];
};
// Parsed documents and their validation errors, per validate function and
// schema. A page sends the same composed query on every render, so most
// requests skip both steps.
const preparedCache = new WeakMap<typeof validate, WeakMap<GraphQLSchema, Map<string, Prepared>>>();

// `$_ref__` placeholders are undeclared on purpose: they are replaced before
// their field runs, and that field is validated again at that point.
const isPlaceholderError = (err: GraphQLError) => err.message.startsWith('Variable "$_ref__');

function prepare(schema: GraphQLSchema, source: string, check: typeof validate): Prepared {
  let bySchema = preparedCache.get(check);
  if (!bySchema) preparedCache.set(check, (bySchema = new WeakMap()));
  let cache = bySchema.get(schema);
  if (!cache) bySchema.set(schema, (cache = new Map()));

  const hit = cache.get(source);
  if (hit) {
    // Map keeps insertion order: re-inserting makes it the most recently used.
    cache.delete(source);
    cache.set(source, hit);
    return hit;
  }
  const doc = parse(source);
  const prepared = { doc, errors: check(schema, doc) };
  cache.set(source, prepared);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return prepared;
}

async function* executeFields({
  schema,
  source,
  rootValue,
  contextValue,
  variableValues,
  operationName,
  execute: run = execute,
  validate: check = validate,
}: ExecuteOptions): AsyncGenerator<ExecutionResult> {
  let prepared: Prepared;
  try {
    prepared = prepare(schema, source, check);
  } catch (err) {
    yield { errors: [err as GraphQLError] };
    return;
  }
  const { doc, errors } = prepared;

  const op = doc.definitions[0] as OperationDefinitionNode;
  // Only plain queries are split. Mutations, variables and fragments run as one document.
  if (doc.definitions.length !== 1 || op.operation !== "query" || op.variableDefinitions?.length) {
    yield errors.length
      ? { errors }
      : await run({
          schema,
          document: doc,
          rootValue,
          contextValue,
          variableValues,
          operationName,
        });
    return;
  }
  // When the batch as a whole is valid, fields only need validating again if
  // their arguments were substituted. Otherwise each field is validated on its
  // own, so that only the invalid ones fail.
  const batchValid = errors.every(isPlaceholderError);

  const single = (sel: SelectionNode): DocumentNode => ({
    ...doc,
    definitions: [{ ...op, selectionSet: { ...op.selectionSet, selections: [sel] } }],
  });

  prepared.refs ??= op.selectionSet.selections.map(refsIn);
  const byAlias = new Map<string, Promise<ExecutionResult>>();
  const fields = op.selectionSet.selections.map((sel, index) => {
    const alias = sel.kind === Kind.FIELD ? (sel.alias ?? sel.name).value : undefined;
    const refs = prepared.refs![index]!;
    // Looked up before anything is awaited, when only earlier fields are
    // registered: a reference can't point forward, so there are no cycles.
    const deps = refs.map((r) => byAlias.get(r.alias));

    const result = (async (): Promise<ExecutionResult> => {
      let document = single(sel);
      if (refs.length) {
        const values = new Map<string, unknown>();
        for (const [i, r] of refs.entries()) {
          const dep = await deps[i];
          const value = r.path.reduce((data: any, key) => data?.[key], dep?.data?.[r.alias]);
          if (value === undefined) {
            return failed(alias, `unresolved reference to ${r.alias}.${r.path.join(".")}`);
          }
          values.set(r.variable, value);
        }
        // Print each value as the type of the argument it fills: a forwarded
        // "DESC" must become the enum DESC, not the string "DESC".
        const typeInfo = new TypeInfo(schema);
        document = visit(
          document,
          visitWithTypeInfo(typeInfo, {
            Variable(v) {
              if (!values.has(v.name.value)) return;
              const value = values.get(v.name.value);
              const type = typeInfo.getInputType();
              return (type && astFromValue(value, type)) || toLiteral(value);
            },
          }),
        );
      }
      if (refs.length || !batchValid) {
        const fieldErrors = check(schema, document);
        if (fieldErrors.length) return failed(alias, fieldErrors);
      }
      return run({ schema, document, rootValue, contextValue });
    })();

    if (alias) byAlias.set(alias, result);
    return result;
  });

  // Yield in completion order.
  const done: ExecutionResult[] = [];
  let wake: (() => void) | undefined;
  for (const field of fields) {
    field
      .catch((err): ExecutionResult => ({ errors: [toGraphQLError(err)] }))
      .then((result) => {
        done.push(result);
        wake?.();
      });
  }
  for (let yielded = 0; yielded < fields.length; yielded++) {
    if (!done.length) await new Promise<void>((resolve) => (wake = resolve));
    yield done.shift()!;
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
    if (req.method !== "POST") {
      return Response.json(
        { errors: [{ message: "use POST with a JSON body" }] },
        { status: 405, headers: { allow: "POST" } },
      );
    }
    const body: unknown = await req.json().catch(() => undefined);
    const { query, variables, operationName } = (body ?? {}) as Record<string, unknown>;
    const bad = (message: string) => Response.json({ errors: [{ message }] }, { status: 400 });
    if (typeof query !== "string") return bad('expected a JSON body with a "query" string');
    if (variables != null && (typeof variables !== "object" || Array.isArray(variables))) {
      return bad('"variables" must be an object');
    }
    if (operationName != null && typeof operationName !== "string") {
      return bad('"operationName" must be a string');
    }
    const results = splitExecute({
      ...options,
      source: query,
      variableValues: variables as Record<string, unknown> | null | undefined,
      operationName,
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
    // The client went away: close the results instead of leaving them suspended.
    async cancel() {
      await it.return?.();
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

type YogaLike = {
  getEnveloped(context: object): {
    schema: GraphQLSchema;
    execute: typeof execute;
    validate: typeof validate;
    contextFactory(): unknown;
  };
};
type Params = { query?: string; variables?: Record<string, unknown>; operationName?: string };

const wantsStream = (request: Request) =>
  request.headers.get("accept")?.includes("application/x-ndjson") ?? false;

/**
 * A GraphQL Yoga plugin: `createYoga({ schema, plugins: [useLaguz()] })`. Batches
 * from the laguz client stream field by field and forward `ref()` values,
 * through Yoga's own context, validation and execution, so its plugins (auth,
 * limits, masked errors, tracing) still apply. Other requests are untouched.
 */
export function useLaguz() {
  let yoga: YogaLike | undefined;
  return {
    onYogaInit(payload: { yoga: YogaLike }) {
      yoga = payload.yoga;
    },
    onParams(payload: {
      request: Request;
      params: Params;
      setParamsHandler(
        handler: (payload: { request: Request; params: Params; context: object }) => unknown,
      ): void;
    }) {
      const { query } = payload.params;
      // A streaming client, or placeholders only laguz resolves.
      if (
        typeof query !== "string" ||
        !(wantsStream(payload.request) || query.includes("$_ref__"))
      ) {
        return;
      }
      payload.setParamsHandler(async ({ request, params, context }) => {
        // As Yoga's own handler does before building the context.
        Object.assign(context, { request, params });
        const {
          schema,
          execute: run,
          validate: check,
          contextFactory,
        } = yoga!.getEnveloped(context);
        const results = splitExecute({
          schema,
          source: params.query!,
          execute: run,
          validate: check,
          contextValue: await contextFactory(),
          variableValues: params.variables,
          operationName: params.operationName,
        });
        return wantsStream(request) ? results : merged(results);
      });
    },
    onResultProcess(payload: {
      request: Request;
      result: unknown;
      setResultProcessor(processor: (result: any) => Response, mediaType: string): void;
    }) {
      if (wantsStream(payload.request) && isIterable(payload.result)) {
        payload.setResultProcessor((result) => ndjson(result), "application/x-ndjson");
      }
    },
  };
}

const isIterable = (value: unknown): value is AsyncIterable<unknown> =>
  value != null && typeof value === "object" && Symbol.asyncIterator in value;
