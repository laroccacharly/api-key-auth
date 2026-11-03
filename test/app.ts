import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Clock, Config, Console, type Duration, Effect, FileSystem, Layer, Path, Redacted, Schema, Stdio, Terminal } from "effect"
import { Command } from "effect/cli"
import { Base64Url } from "effect/encoding"
import { FetchHttpClient, type HttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiClient, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { keysCommand } from "../src/cli.ts"
import { ApiKeyAuth, ApiKeyRoutes, CurrentApiKey, makeApiKeyRoutes } from "../src/index.ts"

const Caller = Schema.Struct({ name: Schema.String, scopes: Schema.Array(Schema.String) })

/** Needs the `push` scope, annotated on all its routes. */
class PushRoutes extends HttpApiGroup.make("push")
  .add(HttpApiEndpoint.post("notify", "/api/push", { success: Caller }))
  .middleware(ApiKeyAuth.Bearer)
  .annotate(ApiKeyAuth.Scope, "push") {}

/** `generate` needs the `images` scope, annotated on the endpoint; `whoami` only a valid key. */
class ImagesRoutes extends HttpApiGroup.make("images")
  .add(
    HttpApiEndpoint.post("generate", "/api/images", { success: Caller }).annotate(ApiKeyAuth.Scope, "images"),
    HttpApiEndpoint.get("whoami", "/api/whoami", { success: Caller }),
  )
  .middleware(ApiKeyAuth.Bearer) {}

/** App-wide middleware, as an app's rate limit would be: it wraps `ApiKeyRoutes` too, and marks every response. */
class Stamp extends HttpApiMiddleware.Service<Stamp>()("test/Stamp") {}

const stamp = Layer.succeed(Stamp, Stamp.of((httpEffect) => Effect.map(httpEffect, HttpServerResponse.setHeader("x-stamp", "app"))))

export class TestApi extends HttpApi.make("test").add(ApiKeyRoutes).add(PushRoutes).add(ImagesRoutes).middleware(Stamp) {}

/** The same routes, with the admin routes under `/admin` instead of `/api`. */
class PrefixedApi extends HttpApi.make("test").add(makeApiKeyRoutes("/admin")).add(PushRoutes).add(ImagesRoutes).middleware(Stamp) {}

const caller = CurrentApiKey.useSync(({ name, scopes }) => ({ name, scopes }))

const pushHandlers = HttpApiBuilder.group(TestApi, "push", (handlers) => handlers.handle("notify", () => caller))

const imagesHandlers = HttpApiBuilder.group(TestApi, "images", (handlers) =>
  handlers.handleAll({ generate: () => caller, whoami: () => caller }))

export const baseUrl = "https://app.example"
export const adminKey = Redacted.make("the-admin-key-of-the-test-app")

export interface TestAppOptions {
  /** The SQLite file; a fresh in-memory database by default. */
  readonly filename?: string
  readonly prefix?: string
  /** `/admin` instead of `/api` for the admin routes. */
  readonly adminPrefix?: boolean
}

const apiKeyAuthOf = (adminPrefix: boolean, options: ApiKeyAuth.ApiKeyAuthOptions) => {
  if (adminPrefix) return ApiKeyAuth.layer(PrefixedApi, options)
  return ApiKeyAuth.layer(TestApi, options)
}

const appRoutes = (options: TestAppOptions) => {
  const keyOptions = { adminKey: Config.succeed(adminKey), scopes: ["push", "images"], prefix: options.prefix ?? "" }
  return HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide([pushHandlers, imagesHandlers]),
    Layer.provide(apiKeyAuthOf(options.adminPrefix === true, keyOptions)),
    Layer.provide(stamp),
  )
}

/** The test app as a fetch handler over SQLite, a test clock it moves, and typed clients of it. */
export const makeTestApp = async (options: TestAppOptions = {}) => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()))
  const { handler, dispose } = HttpRouter.toWebHandler(
    appRoutes(options).pipe(
      Layer.provide(SqliteClient.layer({ filename: options.filename ?? ":memory:" })),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(Layer.succeed(Clock.Clock, clock)),
    ),
    { disableLogger: true },
  )
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))

  /** Runs `effect` with `fetch` reaching this app. */
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)))

  /** The typed client, sending `key` as a consumer, or `admin` as the admin, or nothing. */
  const client = (credentials: { readonly key?: string; readonly admin?: Redacted.Redacted<string> } = {}) =>
    HttpApiClient.make(TestApi, { baseUrl }).pipe(Effect.provide(clientMiddlewares(credentials)))

  /** The tag of the error `effect` fails with, or `ok`. */
  const outcome = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    run(effect.pipe(Effect.as("ok"), Effect.catch((error) => Effect.succeed(error._tag))))

  const advance = (duration: Duration.Input) => Effect.runPromise(clock.adjust(duration))
  return { fetch, run, client, outcome, advance, dispose }
}

export type TestApp = Awaited<ReturnType<typeof makeTestApp>>

/** The client middlewares sending what `credentials` hold. */
const clientMiddlewares = (credentials: { readonly key?: string; readonly admin?: Redacted.Redacted<string> }) => {
  const layers = []
  if (credentials.key !== undefined) layers.push(ApiKeyAuth.layerClient(Redacted.make(credentials.key)))
  if (credentials.admin !== undefined) layers.push(ApiKeyAuth.layerAdminClient(credentials.admin))
  return Layer.mergeAll(Layer.empty, ...layers)
}

const unusedTerminal = Terminal.make({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  size: Effect.die("unused"),
  readInput: Effect.die("unused"),
  readLine: Effect.die("unused"),
  display: () => Effect.void,
})

const cliEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(Terminal.Terminal, unusedTerminal),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("unused"))),
)

const printed = (args: ReadonlyArray<string>) => args.join(" ")

/** Runs the app's `keys` command with `args` against `app`, and what it wrote to stdout and stderr. */
export const runKeysCommand = async (app: TestApp, args: ReadonlyArray<string>, key = adminKey) => {
  const stdout: Array<string> = []
  const stderr: Array<string> = []
  const console: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: (...line: ReadonlyArray<string>) => void stdout.push(printed(line)),
    error: (...line: ReadonlyArray<string>) => void stderr.push(printed(line)),
  })
  const keys = keysCommand({ api: TestApi, url: Effect.succeed(baseUrl), adminKey: Effect.succeed(key) })
  const exit = await app.run(
    Command.runWith(keys, { version: "0.0.0", renderErrors: false })(args).pipe(
      Effect.provide(cliEnvironment),
      Effect.provideService(Console.Console, console),
      Effect.exit,
    ),
  )
  return { exit, stdout, stderr }
}

/** A key in the format the library makes, never stored. */
export const unknownKey = () => Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)))
