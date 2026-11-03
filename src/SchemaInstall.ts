// Option A of the design: the library brings its tables up to date itself, once per isolate, before its first query.
// Everything about installing the schema lives here, so another option can replace this module alone.

import { Clock, Effect, Predicate } from "effect"
import { SqlClient, type SqlError, type Statement } from "effect/sql"

/**
 * The schema, one list of statements per version, in order. Each statement is idempotent, so two cold starts racing
 * on a version are harmless. Never edit a shipped version: add the next one.
 */
export const schemaVersions: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE IF NOT EXISTS api_key_auth_keys (
      id           TEXT PRIMARY KEY,
      key_hash     TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      email        TEXT,
      scopes       TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    )`,
  ],
  ["CREATE INDEX IF NOT EXISTS api_key_auth_keys_email ON api_key_auth_keys (email)"],
]

const createSchemaTable = "CREATE TABLE IF NOT EXISTS api_key_auth_schema (version INTEGER PRIMARY KEY, installed_at INTEGER NOT NULL)"

/** A client that runs statements as one atomic batch, as `@effect/sql-d1`'s `D1Client` does. */
interface BatchingSqlClient extends SqlClient.SqlClient {
  readonly batch: (statements: ReadonlyArray<Statement.Statement<object>>) => Effect.Effect<ReadonlyArray<object>, SqlError.SqlError>
}

const canBatch = (sql: SqlClient.SqlClient): sql is BatchingSqlClient => Predicate.hasProperty(sql, "batch") && Predicate.isFunction(sql.batch)

/** D1 refuses transactions but runs a batch atomically; every other driver gets a transaction. */
const runAtomically = (sql: SqlClient.SqlClient, statements: ReadonlyArray<Statement.Statement<object>>) => {
  if (canBatch(sql)) return Effect.asVoid(sql.batch(statements))
  return sql.withTransaction(Effect.forEach(statements, (statement) => statement, { discard: true }))
}

const schemaTableExists = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_key_auth_schema'`,
    (rows) => rows.length > 0,
  )

/** A failed read of the bookkeeping table means nothing is installed when the table isn't there, and fails otherwise. */
const noVersionsIfNoSchemaTable = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, error: SqlError.SqlError) {
  if (yield* schemaTableExists(sql)) return yield* error
  return []
})

const allVersions = schemaVersions.map((_, index) => index + 1)

/** The versions not recorded yet; all of them on a database the library never touched. One read once installed. */
const missingVersions = (sql: SqlClient.SqlClient) =>
  sql<{ readonly version: number }>`SELECT version FROM api_key_auth_schema`.pipe(
    Effect.catchTag("SqlError", (error) => noVersionsIfNoSchemaTable(sql, error)),
    Effect.map((rows) => {
      const installed = new Set(rows.map((row) => row.version))
      return allVersions.filter((version) => !installed.has(version))
    }),
  )

const statementsOf = (sql: SqlClient.SqlClient, versions: ReadonlyArray<number>, now: number) => [
  sql.unsafe(createSchemaTable),
  ...versions.flatMap((version) => [
    ...(schemaVersions[version - 1] ?? []).map((statement) => sql.unsafe(statement)),
    sql`INSERT OR IGNORE INTO api_key_auth_schema (version, installed_at) VALUES (${version}, ${now})`,
  ]),
]

/** A failed install is fine when another isolate installed the same versions meanwhile. */
const failUnlessInstalledMeanwhile = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, error: SqlError.SqlError) {
  if ((yield* missingVersions(sql)).length > 0) return yield* error
})

/** Runs the missing versions as one batch. */
const installMissingVersions = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  const missing = yield* missingVersions(sql)
  if (missing.length === 0) return
  const now = yield* Clock.currentTimeMillis
  yield* runAtomically(sql, statementsOf(sql, missing, now)).pipe(
    Effect.catchTag("SqlError", (error) => failUnlessInstalledMeanwhile(sql, error)),
  )
})

/** The databases brought up to date in this isolate: a D1 client's binding, or the client itself for other drivers. */
const upToDateDatabases = new WeakSet<object>()

const databaseOf = (sql: SqlClient.SqlClient): object => {
  if (Predicate.hasProperty(sql, "config") && Predicate.hasProperty(sql.config, "db") && Predicate.isObject(sql.config.db)) {
    return sql.config.db
  }
  return sql
}

/** Brings the library's tables up to date, once per database and isolate. */
export const installSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const database = databaseOf(sql)
  if (upToDateDatabases.has(database)) return
  yield* installMissingVersions(sql)
  upToDateDatabases.add(database)
})
