/**
 * What a consumer selects on a root field.
 *
 * - `"name"`: a scalar field
 * - `{ projects: ["id"] }`: a nested selection
 * - `{ projects: { args: { first: 3 }, fields: ["id"] } }`: a field with arguments
 * - `{ recent: { field: "projects", args: { first: 3 }, fields: ["id"] } }`: the same field under another name
 */
export type Fields = (string | { [out: string]: Fields | FieldArg })[];
export type FieldArg = { field?: string; args?: Record<string, unknown>; fields?: Fields };

/** A merged selection. Keys are `field` or `field(args)`; a leaf is `{}`. */
export type Tree = { [key: string]: Tree };

/**
 * An argument value read from another root field's result, for queries that
 * depend on each other. See {@link ref}.
 */
export type Ref = { $ref: [root: string, args: object, path: string] };

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

export function name(s: string): string {
  if (!NAME.test(s)) throw new Error(`invalid GraphQL name: ${s}`);
  return s;
}

/**
 * Use the value at `path` in `root(args)` as an argument:
 * `ref("user", { id: 1 }, "teamId")`. Refs can be nested.
 */
export function ref(root: string, args: object, path: string): Ref {
  for (const segment of path.split(".")) {
    if (name(segment).includes("__"))
      throw new Error(`ref path segments can't contain "__": ${segment}`);
  }
  return { $ref: [name(root), args, path] };
}

export const isRef = (v: unknown): v is Ref => v !== null && typeof v === "object" && "$ref" in v;

export function collectRefs(v: unknown): Ref[] {
  if (isRef(v)) return [v];
  if (v && typeof v === "object") return Object.values(v).flatMap(collectRefs);
  return [];
}

export const pathTree = (path: string): Tree =>
  path.split(".").reduceRight((tree: Tree, key) => ({ [key]: tree }), {});

export const getPath = (data: any, path: string): unknown =>
  path.split(".").reduce((value, key) => value?.[key], data);

export function toTree(fields: Fields): Tree {
  const tree: Tree = {};
  for (const f of fields) {
    if (typeof f === "string") {
      tree[name(f)] ??= {};
      continue;
    }
    for (const [out, v] of Object.entries(f)) {
      name(out);
      const key = Array.isArray(v) ? out : canonical(v.field ?? out, v.args ?? {});
      const sub = Array.isArray(v) ? v : (v.fields ?? []);
      tree[key] = merge(tree[key] ?? {}, toTree(sub));
    }
  }
  return tree;
}

export function merge(a: Tree, b: Tree): Tree {
  const tree = { ...a };
  for (const key in b) tree[key] = merge(tree[key] ?? {}, b[key]!);
  return tree;
}

/** The part of `want` that `have` doesn't cover, or null. */
export function diff(want: Tree, have: Tree): Tree | null {
  let missing: Tree | null = null;
  for (const key in want) {
    const sub = have[key] ? diff(want[key]!, have[key]) : want[key]!;
    if (sub) (missing ??= {})[key] = sub;
  }
  return missing;
}

/**
 * True when fetching `tree` would add fields inside a list we already hold.
 * Merging two fetches of a list by index is wrong if the list changed in
 * between, so the caller refetches the whole selection instead.
 */
export function touchesList(tree: Tree, data: any): boolean {
  if (!data || typeof data !== "object") return false;
  if (Array.isArray(data)) return true;
  return Object.keys(tree).some((key) => touchesList(tree[key]!, data[responseKey(key)]));
}

const canonical = (field: string, args: object) => name(field) + printArgs(args);

// FNV-1a in base 36: a short, stable alias suffix.
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// Fields with arguments are aliased: two consumers may select the same field
// with different arguments, and both results have to coexist in one entry.
function responseKey(key: string): string {
  const paren = key.indexOf("(");
  return paren < 0 ? key : `${key.slice(0, paren)}_${hash(key)}`;
}

/** The key under which `field(args)` is stored in raw entry data. */
export const fieldKey = (field: string, args: object = {}): string =>
  responseKey(canonical(field, args));

/** Project raw entry data onto one consumer's selection, with its own output names. */
export function view(data: any, fields: Fields): any {
  if (data == null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((item) => view(item, fields));
  const out: any = {};
  for (const f of fields) {
    if (typeof f === "string") {
      out[f] = data[f];
      continue;
    }
    for (const [key, v] of Object.entries(f)) {
      if (Array.isArray(v)) {
        out[key] = view(data[key], v);
      } else {
        const raw = data[fieldKey(v.field ?? key, v.args)];
        out[key] = v.fields ? view(raw, v.fields) : raw;
      }
    }
  }
  return out;
}

export function printTree(tree: Tree): string {
  const keys = Object.keys(tree);
  if (!keys.length) return "";
  const field = (key: string) => (responseKey(key) === key ? key : `${responseKey(key)}: ${key}`);
  return ` { ${keys.map((key) => field(key) + printTree(tree[key]!)).join(" ")} }`;
}

/**
 * Print a JS value as a GraphQL literal. JSON string escaping is valid GraphQL
 * string escaping. Object keys are sorted so equal arguments print the same.
 * Refs print through `onRef`, or as a readable key when it is absent.
 * Enum values are not supported yet: strings always print quoted.
 */
export function printValue(v: any, onRef?: (r: Ref) => string): string {
  if (isRef(v)) return onRef ? onRef(v) : `@${v.$ref[0]}${printArgs(v.$ref[1])}.${v.$ref[2]}`;
  if (typeof v?.toJSON === "function") v = v.toJSON();
  if (Array.isArray(v)) return `[${v.map((x) => printValue(x, onRef)).join(", ")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v)
      .filter((key) => v[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${name(key)}: ${printValue(v[key], onRef)}`).join(", ")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function printArgs(args: object, onRef?: (r: Ref) => string): string {
  const inner = printValue(args, onRef).slice(1, -1);
  return inner ? `(${inner})` : "";
}

/** `root(args) { fields }`: the text the pool sends for a single consumer. */
export const printField = (root: string, args: object, fields: Fields): string =>
  name(root) + printArgs(args) + printTree(toTree(fields));

/**
 * Merge a partial result into cached data. Two arrays only meet here when they
 * come from the same fetch shape, because `touchesList` forces whole refetches.
 */
export function mergeData(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b)) return b.map((item, i) => mergeData(a[i], item));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(b)) {
    const out = { ...a };
    for (const key in b) out[key] = mergeData(a[key], b[key]);
    return out;
  }
  return b;
}
