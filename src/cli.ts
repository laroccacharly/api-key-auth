import { Array, Console, DateTime, Effect, FileSystem, Option, Path, type PlatformError, type Redacted, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import type { HttpClientError } from "effect/http"
import { type HttpApi, HttpApiClient, type HttpApiGroup } from "effect/http-api"
import type { ApiKey } from "./ApiKey.ts"
import { layerAdminClient } from "./ApiKeyAuth.ts"
import { ApiKeyAuthApi, type RequireApiKeyRoutes } from "./ApiKeyRoutes.ts"
import type { NotFound, Unauthorized, UnknownScope } from "./Errors.ts"
import { contentsOf, libraryFiles, misplacedFile, missingVersions, newMigrationFiles } from "./Schema.ts"

export interface KeysCommandOptions<ApiId extends string, Groups extends HttpApiGroup.Constraint, E, R> {
  /** The app's `HttpApi`, with `ApiKeyRoutes`. */
  readonly api: HttpApi.HttpApi<ApiId, Groups> & RequireApiKeyRoutes<Groups>
  /** Where the app is reached, e.g. `https://proxy.example.com`. */
  readonly url: Effect.Effect<string, E, R>
  readonly adminKey: Effect.Effect<Redacted.Redacted<string>, E, R>
}

/** Something the command couldn't do, said in one line, which `Command.run` prints. */
export class KeysCommandError extends Schema.TaggedError<KeysCommandError>()("KeysCommandError", { message: Schema.String }) {
  override get [CliError.userMessage]() {
    return this.message
  }
}

type CallFailure = Unauthorized | UnknownScope | NotFound | HttpClientError.HttpClientError | Schema.SchemaError

const messageOf = (url: string, error: CallFailure) => {
  switch (error._tag) {
    case "Unauthorized":
      return `${url} refused the admin key`
    case "UnknownScope":
      return `${url} doesn't accept the scope ${error.scope}`
    case "NotFound":
      return `${url} has no key ${error.id}`
    case "HttpClientError":
      return `Could not reach ${url}: ${error.message}`
    case "SchemaError":
      return `${url} answered something unexpected: ${error.message}`
  }
}

const formatTime = (time: DateTime.Utc) => DateTime.formatIso(time).slice(0, 16).replace("T", " ")

const statusOf = (apiKey: ApiKey) => Option.match(apiKey.revoked_at, { onNone: () => "active", onSome: (at) => `revoked ${formatTime(at)}` })

const rowOf = (apiKey: ApiKey) => [
  apiKey.id,
  apiKey.name,
  Option.getOrElse(apiKey.email, () => "-"),
  apiKey.scopes.join(","),
  formatTime(apiKey.created_at),
  Option.match(apiKey.last_used_at, { onNone: () => "never", onSome: formatTime }),
  statusOf(apiKey),
]

const header = ["ID", "NAME", "EMAIL", "SCOPES", "CREATED", "LAST USED", "STATUS"]

/** The rows as columns padded to their widest cell. */
const formatTable = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const widths = header.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)))
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n")
}

const nameArgument = Argument.String("name").pipe(Argument.withDescription("A label for the key; it needn't be unique"))
const emailFlag = Flag.String("email").pipe(Flag.optional, Flag.withDescription("Whose key it is, to find their keys later"))
const scopeFlag = Flag.String("scope").pipe(Flag.atLeast(1), Flag.withDescription("A scope the key may call, or `all`; repeat for more"))
const idArgument = Argument.String("id").pipe(Argument.withDescription("The key's id, from `list`"))
const dirArgument = Argument.Directory("dir").pipe(Argument.withDescription("The app's migrations folder, e.g. ./migrations"))

const fileSystemFailure = (error: PlatformError.PlatformError) => new KeysCommandError({ message: error.message })

/** The file names in `dir`, none when it doesn't exist yet; fails when the library's are out of place. */
const namesIn = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(dir))) return []
  const names = yield* fs.readDirectory(dir)
  const misplaced = misplacedFile(names)
  if (Option.isSome(misplaced)) {
    const message = `${misplaced.value} is out of place: the api-key-auth files must run v1, v2, … in order, once each`
    return yield* new KeysCommandError({ message })
  }
  return names
}, Effect.catchTag("PlatformError", (error) => Effect.fail(fileSystemFailure(error))))

const newMigrations = Command.make("new", { dir: dirArgument }, ({ dir }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files = newMigrationFiles(yield* namesIn(dir))
    if (files.length === 0) return yield* Console.error(`${dir} has every api-key-auth migration`)
    yield* fs.makeDirectory(dir, { recursive: true })
    for (const file of files) {
      yield* fs.writeFileString(path.join(dir, file.name), file.contents)
      yield* Console.error(`Wrote ${path.join(dir, file.name)}`)
    }
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(fileSystemFailure(error))))).pipe(Command.withDescription("Write the library's missing migrations into the app's folder"))

/** The library's files in `dir` whose contents aren't what `new` wrote. */
const editedFiles = Effect.fnUntraced(function* (dir: string, names: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const edited: Array<string> = []
  for (const [version, name] of libraryFiles(names)) {
    if ((yield* fs.readFileString(path.join(dir, name))) !== contentsOf(version)) edited.push(name)
  }
  return edited
})

const checkMigrations = Command.make("check", { dir: dirArgument }, ({ dir }) =>
  Effect.gen(function* () {
    const names = yield* namesIn(dir)
    const missing = missingVersions(names)
    if (missing.length > 0) {
      const versions = missing.map((version) => `v${version}`).join(", ")
      return yield* new KeysCommandError({ message: `${dir} lacks api-key-auth ${versions}: run \`keys migrations new ${dir}\`` })
    }
    const edited = yield* editedFiles(dir, names).pipe(Effect.mapError(fileSystemFailure))
    if (edited.length > 0) {
      return yield* new KeysCommandError({ message: `${edited.join(", ")} no longer hold what \`keys migrations new\` wrote` })
    }
    yield* Console.error(`${dir} has every api-key-auth migration, unedited`)
  })).pipe(Command.withDescription("Fail unless the app's folder has every migration of the library, unedited"))

const migrations = Command.make("migrations").pipe(
  Command.withDescription("The library's tables, as files in the app's migrations"),
  Command.withSubcommands([newMigrations, checkMigrations]),
)

/**
 * `keys create | list | revoke | delete`, an `effect/cli` command for the app's own CLI, calling its `ApiKeyRoutes` at `url`
 * with `adminKey`. `create` prints the key alone on stdout, so it pipes; everything else goes to stderr.
 * `keys migrations new | check <dir>` write and check the library's migrations in the app's folder, without the app.
 * The calls need an `HttpClient`, which the app provides, e.g. `FetchHttpClient.layer`.
 */
export const keysCommand = <ApiId extends string, Groups extends HttpApiGroup.Constraint, E, R>(
  options: KeysCommandOptions<ApiId, Groups, E, R>,
) => {
  const callApiKeyRoutes = <A>(
    use: (client: HttpApiClient.ForApi<typeof ApiKeyAuthApi>["apiKeys"]) => Effect.Effect<A, CallFailure>,
  ) =>
    Effect.gen(function* () {
      const baseUrl = yield* options.url
      const client = yield* HttpApiClient.make(options.api as never as typeof ApiKeyAuthApi, { baseUrl }).pipe(
        Effect.provide(layerAdminClient(yield* options.adminKey)),
      )
      return yield* use(client.apiKeys).pipe(Effect.mapError((error) => new KeysCommandError({ message: messageOf(baseUrl, error) })))
    })

  const create = Command.make("create", { name: nameArgument, email: emailFlag, scopes: scopeFlag }, ({ name, email, scopes }) =>
    Effect.gen(function* () {
      if (!Array.isReadonlyArrayNonEmpty(scopes)) return yield* new KeysCommandError({ message: "Give at least one --scope" })
      const payload = Option.match(email, { onNone: () => ({ name, scopes }), onSome: (address) => ({ name, email: address, scopes }) })
      const created = yield* callApiKeyRoutes((client) => client.create({ payload }))
      yield* Console.error(`Created the key ${created.name} (${created.id}), scopes ${created.scopes.join(", ")}. It is shown once:`)
      yield* Console.log(created.key)
    })).pipe(Command.withDescription("Create a key and print it, alone on stdout"))

  const list = Command.make("list", { email: emailFlag }, ({ email }) =>
    Effect.gen(function* () {
      const query = Option.match(email, { onNone: () => ({}), onSome: (address) => ({ email: address }) })
      const apiKeys = yield* callApiKeyRoutes((client) => client.list({ query }))
      if (apiKeys.length === 0) return yield* Console.error("No keys")
      yield* Console.log(formatTable([header, ...apiKeys.map(rowOf)]))
    })).pipe(Command.withDescription("List the keys, revoked ones marked"))

  const revoke = Command.make("revoke", { id: idArgument }, ({ id }) =>
    Effect.gen(function* () {
      yield* callApiKeyRoutes((client) => client.revoke({ params: { id } }))
      yield* Console.error(`Revoked the key ${id}`)
    })).pipe(Command.withDescription("Revoke a key: it answers 401 from now on"))

  const deleteCommand = Command.make("delete", { id: idArgument }, ({ id }) =>
    Effect.gen(function* () {
      yield* callApiKeyRoutes((client) => client.delete({ params: { id } }))
      yield* Console.error(`Deleted the key ${id}`)
    })).pipe(Command.withDescription("Delete a key: it answers 401 and leaves the list"))

  return Command.make("keys").pipe(Command.withDescription("Manage API keys"), Command.withSubcommands([create, list, revoke, deleteCommand, migrations]))
}
