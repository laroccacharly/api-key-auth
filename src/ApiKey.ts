import { Schema, SchemaTransformation } from "effect"

/** The scope that opens every route, including routes and scopes added later. */
export const allScope = "all"

/** A short lowercase name, e.g. `push`. */
export const ScopeName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/u, { expected: "a short lowercase scope name" }))

/** An email address, trimmed and lowercased as email-auth does, so it matches a signed-in email. */
export const Email = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim()),
  Schema.decode(SchemaTransformation.toLowerCase()),
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/u, { expected: "an email address" }), Schema.isMaxLength(254)),
)

/** What a handler knows of the key that called, through `CurrentApiKey`. */
export const CallingApiKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.OptionFromNullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  created_at: Schema.DateTimeUtcFromString,
})
export type CallingApiKey = typeof CallingApiKey.Type

/** A key's record, as `list` returns it; never its hash. */
export const ApiKey = Schema.Struct({
  ...CallingApiKey.fields,
  last_used_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  revoked_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
})
export type ApiKey = typeof ApiKey.Type

/** A new key and the key itself, shown this once. */
export const CreatedApiKey = Schema.Struct({ ...CallingApiKey.fields, key: Schema.String })
export type CreatedApiKey = typeof CreatedApiKey.Type

/** What `create` takes: a label (not unique), an optional email, at least one scope. */
export const NewApiKey = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  email: Schema.optionalKey(Email),
  scopes: Schema.NonEmptyArray(ScopeName),
})
export type NewApiKey = typeof NewApiKey.Type
