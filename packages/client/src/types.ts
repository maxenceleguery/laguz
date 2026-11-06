// Types for pools created with a schema: `createPool<Schema>(fetcher)`, where
// `Schema` comes from `laguz-types`. Object types are interfaces and fields
// that take arguments are methods, so argument types can be read with `infer`.
import type { Fields, Ref } from "./selection.ts";

export type SchemaShape = { Query: object };

type IsAny<T> = 0 extends 1 & T ? true : false;
type Prettify<T> = { [K in keyof T]: T[K] } & {};
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** A field's type, whether or not it takes arguments. */
type Unwrap<F> = F extends (...args: never[]) => infer R ? R : F;
/** A field's arguments. Fields without arguments take none. */
export type ArgsOf<F> = F extends (args: infer A) => unknown
  ? NonNullable<A>
  : Record<string, never>;
/** The object type a selection applies to: lists and null removed. */
type Element<T> = T extends readonly (infer E)[] ? Element<E> : NonNullable<T>;

type Keys<T> = keyof T & string;
type ScalarKeys<T> = {
  [K in Keys<T>]: Element<Unwrap<T[K]>> extends object ? never : K;
}[Keys<T>];

type FieldOptions<F> = {
  readonly args?: ArgsOf<F>;
  readonly fields?: Selection<Element<Unwrap<F>>>;
};
type Renamed<T> = {
  [K in Keys<T>]: FieldOptions<T[K]> & { readonly field: K };
}[Keys<T>];

/** What can be selected on `T`: scalar names, nested selections, fields with arguments. */
export type Selection<T> = readonly (
  | ScalarKeys<T>
  | { readonly [K in Keys<T>]?: Selection<Element<Unwrap<T[K]>>> | FieldOptions<T[K]> }
  | { readonly [out: string]: Renamed<T> }
)[];

/** The data a selection `F` returns for a value of type `T`. */
export type Selected<T, F> =
  IsAny<T> extends true
    ? any
    : T extends null | undefined
      ? T
      : T extends readonly (infer E)[]
        ? Selected<E, F>[]
        : T extends object
          ? F extends readonly unknown[]
            ? Prettify<UnionToIntersection<Item<T, F[number]>>>
            : never
          : T;

type Item<T, I> = I extends string
  ? { [K in I & keyof T]: Unwrap<T[K]> }
  : { -readonly [Out in keyof I]: Field<T, Out & string, I[Out]> };

type Field<T, Out extends string, V> = V extends readonly unknown[]
  ? Selected<Unwrap<T[Out & keyof T]>, V>
  : V extends { field: infer Name }
    ? WithFields<Unwrap<T[Name & keyof T]>, V>
    : WithFields<Unwrap<T[Out & keyof T]>, V>;
type WithFields<T, V> = V extends { fields: infer F } ? Selected<T, F> : T;

type Query<S extends SchemaShape> = S["Query"];
type Root<S extends SchemaShape, R> = R extends keyof Query<S> ? Query<S>[R] : never;

export type RootName<S extends SchemaShape> = IsAny<S> extends true ? string : Keys<Query<S>>;
/** Root arguments. Any value can also be a `ref()` to another query's result. */
export type RootArgs<S extends SchemaShape, R> =
  IsAny<S> extends true ? object : { [K in keyof ArgsOf<Root<S, R>>]: ArgsOf<Root<S, R>>[K] | Ref };
export type RootSelection<S extends SchemaShape, R> =
  IsAny<S> extends true ? Fields : Selection<Element<Unwrap<Root<S, R>>>>;
export type RootResult<S extends SchemaShape, R, F> =
  IsAny<S> extends true ? any : Selected<Unwrap<Root<S, R>>, F>;
