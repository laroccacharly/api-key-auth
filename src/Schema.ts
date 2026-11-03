// The library's tables, as numbered migration files the app keeps with its own: `keys migrations new` writes them and
// `keys migrations check` compares them, and the app's migration tool applies them. Nothing runs at runtime.

import { Array, Option } from "effect"

/** The schema, one list of statements per version, in order. Never edit a shipped version: add the next one. */
export const schemaVersions: ReadonlyArray<ReadonlyArray<string>> = [
  [
    `CREATE TABLE api_key_auth_keys (
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
  ["CREATE INDEX api_key_auth_keys_email ON api_key_auth_keys (email)"],
]

export interface MigrationFile {
  readonly name: string
  readonly contents: string
}

const allVersions = schemaVersions.map((_, index) => index + 1)

/** `0003_api_key_auth_v1.sql`: the file of a version, the version being the one after `_v`. */
const libraryFileName = /^\d+_api_key_auth_v(\d+)\.sql$/u

const numberedFileName = /^(\d+)_/u

/** What the file of `version` holds, byte for byte. */
export const contentsOf = (version: number) =>
  [
    `-- api-key-auth schema v${version}, written by \`keys migrations new\`. Don't edit it: a change is the next version.`,
    ...(schemaVersions[version - 1] ?? []).map((statement) => `${statement};`),
  ].join("\n\n") + "\n"

const versionOf = (name: string): ReadonlyArray<readonly [number, string]> => {
  const version = libraryFileName.exec(name)?.[1]
  if (version === undefined) return []
  return [[Number(version), name]]
}

/** The library's files among `names`, by version. */
export const libraryFiles = (names: ReadonlyArray<string>) => new Map(names.flatMap(versionOf))

/**
 * The first of the library's files among `names` out of place: in name order, the order migrations run in, they must be
 * v1, v2, … once each, or a version would run twice or before the one it needs.
 */
export const misplacedFile = (names: ReadonlyArray<string>): Option.Option<string> =>
  Array.findFirst(names.toSorted().flatMap(versionOf), ([version], index) => version !== index + 1).pipe(Option.map(([, name]) => name))

/** The versions without a file among `names`. */
export const missingVersions = (names: ReadonlyArray<string>) => {
  const present = libraryFiles(names)
  return allVersions.filter((version) => !present.has(version))
}

/** The files to add to a migrations folder holding `names`, numbered after its last numbered file. */
export const newMigrationFiles = (names: ReadonlyArray<string>): ReadonlyArray<MigrationFile> => {
  const last = Math.max(0, ...names.map((name) => Number(numberedFileName.exec(name)?.[1] ?? 0)))
  return missingVersions(names).map((version, index) => ({
    name: `${String(last + index + 1).padStart(4, "0")}_api_key_auth_v${version}.sql`,
    contents: contentsOf(version),
  }))
}
