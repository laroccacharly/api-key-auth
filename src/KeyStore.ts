import { Array, Clock, Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { SqlClient, type SqlError, SqlSchema } from "effect/sql"
import { allScope, type ApiKey, type CreatedApiKey, type NewApiKey } from "./ApiKey.ts"
import { NotFound, UnknownScope } from "./Errors.ts"
import { generateKey, hashKeyHex } from "./Key.ts"
import { installSchema } from "./SchemaInstall.ts"

export interface KeyStoreOptions {
  /** Put before every new key, e.g. `pxy_`. None by default. */
  readonly prefix?: string
  /** The scopes `create` accepts, besides `all`. */
  readonly scopes?: ReadonlyArray<string>
}

/** `last_used_at` is written at most this often per key. */
const lastUsedResolution = Duration.minutes(1)

/** A row of `api_key_auth_keys`, without its hash, decoded to the API's record. */
const ApiKeyRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.OptionFromNullOr(Schema.String),
  scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
  created_at: Schema.DateTimeUtcFromMillis,
  last_used_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  revoked_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
})

const InsertedRow = Schema.Struct({
  id: Schema.String,
  key_hash: Schema.String,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
  scopes: Schema.String,
  created_at: Schema.Int,
})

const columns = "id, name, email, scopes, created_at, last_used_at, revoked_at"

/** As the `Email` schema decodes it, for callers of the service who skip the HTTP schemas. */
const normalizeEmail = (email: string) => email.trim().toLowerCase()

const firstUnknownScope = (scopes: ReadonlyArray<string>, accepted: ReadonlySet<string>) =>
  Array.findFirst(scopes, (scope) => !accepted.has(scope))

/** Whether `apiKey` was last used long enough ago, or never, that this use should be written. */
const isLastUseStale = (apiKey: ApiKey, now: number) =>
  Option.match(apiKey.last_used_at, {
    onNone: () => true,
    onSome: (lastUsed) => now - DateTime.toEpochMillis(lastUsed) >= Duration.toMillis(lastUsedResolution),
  })

const makeKeyStore = Effect.fnUntraced(function* (options: KeyStoreOptions) {
  yield* installSchema
  const sql = yield* SqlClient.SqlClient
  const services = yield* Effect.context<Digest.Digest | SecureRandom.SecureRandom>()
  const prefix = options.prefix ?? ""
  const acceptedScopes = new Set([allScope, ...(options.scopes ?? [])])

  const insert = SqlSchema.findOne({
    Request: InsertedRow,
    Result: ApiKeyRow,
    execute: (row) => sql`INSERT INTO api_key_auth_keys ${sql.insert(row)} RETURNING ${sql.unsafe(columns)}`,
  })

  const findByHash = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ApiKeyRow,
    execute: (hash) => sql`SELECT ${sql.unsafe(columns)} FROM api_key_auth_keys WHERE key_hash = ${hash}`,
  })

  const listAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ApiKeyRow,
    execute: () => sql`SELECT ${sql.unsafe(columns)} FROM api_key_auth_keys ORDER BY created_at, id`,
  })

  const listOfEmail = SqlSchema.findAll({
    Request: Schema.String,
    Result: ApiKeyRow,
    execute: (email) => sql`SELECT ${sql.unsafe(columns)} FROM api_key_auth_keys WHERE email = ${email} ORDER BY created_at, id`,
  })

  const create = Effect.fnUntraced(function* (newKey: NewApiKey): Effect.fn.Return<CreatedApiKey, UnknownScope, Digest.Digest | SecureRandom.SecureRandom> {
    const scopes = Array.dedupe(newKey.scopes)
    const unknownScope = firstUnknownScope(scopes, acceptedScopes)
    if (Option.isSome(unknownScope)) return yield* new UnknownScope({ scope: unknownScope.value })
    const key = yield* generateKey(prefix)
    const id = yield* SecureRandom.SecureRandom.use((random) => random.uuidV4())
    const row = {
      id,
      key_hash: yield* hashKeyHex(key),
      name: newKey.name,
      email: newKey.email === undefined ? null : normalizeEmail(newKey.email),
      scopes: JSON.stringify(scopes),
      created_at: yield* Clock.currentTimeMillis,
    }
    const inserted = yield* Effect.orDie(insert(row))
    return { id: inserted.id, name: inserted.name, email: inserted.email, scopes: inserted.scopes, created_at: inserted.created_at, key }
  }, Effect.provideContext(services))

  const list = (filter?: { readonly email?: string }) => {
    if (filter?.email === undefined) return Effect.orDie(listAll())
    return Effect.orDie(listOfEmail(normalizeEmail(filter.email)))
  }

  const revoke = Effect.fnUntraced(function* (id: string): Effect.fn.Return<void, NotFound> {
    const now = yield* Clock.currentTimeMillis
    const revoked = yield* Effect.orDie(sql`UPDATE api_key_auth_keys SET revoked_at = COALESCE(revoked_at, ${now}) WHERE id = ${id} RETURNING id`)
    if (revoked.length === 0) return yield* new NotFound({ id })
  })

  const findByKey = (key: string) => hashKeyHex(key).pipe(Effect.flatMap(findByHash), Effect.orDie, Effect.provideContext(services))

  /** Records a use of `apiKey`, unless one was recorded less than a minute ago. */
  const markUsed = Effect.fnUntraced(function* (apiKey: ApiKey) {
    const now = yield* Clock.currentTimeMillis
    if (!isLastUseStale(apiKey, now)) return
    const staleBefore = now - Duration.toMillis(lastUsedResolution)
    yield* Effect.orDie(sql`UPDATE api_key_auth_keys SET last_used_at = ${now}
      WHERE id = ${apiKey.id} AND (last_used_at IS NULL OR last_used_at <= ${staleBefore})`)
  })

  return { create, list, revoke, findByKey, markUsed }
})

/** The `api_key_auth_keys` table, brought up to date when the layer is built. */
export class KeyStore extends Context.Service<KeyStore, {
  readonly create: (newKey: NewApiKey) => Effect.Effect<CreatedApiKey, UnknownScope>
  readonly list: (filter?: { readonly email?: string }) => Effect.Effect<ReadonlyArray<ApiKey>>
  readonly revoke: (id: string) => Effect.Effect<void, NotFound>
  /** The key whose plaintext is `key`, revoked or not. */
  readonly findByKey: (key: string) => Effect.Effect<Option.Option<ApiKey>>
  /** Records a use of `apiKey`, unless one was recorded less than a minute ago. */
  readonly markUsed: (apiKey: ApiKey) => Effect.Effect<void>
}>()("api-key-auth/KeyStore") {
  static readonly layer = (options: KeyStoreOptions): Layer.Layer<KeyStore, SqlError.SqlError, SqlClient.SqlClient> =>
    Layer.effect(KeyStore, makeKeyStore(options)).pipe(
      Layer.provide([Digest.layerWebCrypto, SecureRandom.layerWebCrypto]),
    )
}
