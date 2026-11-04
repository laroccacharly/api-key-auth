# api-key-auth

API keys for Effect `HttpApi` servers: an admin creates a key, a consumer sends it as a bearer token, and the server
knows which key called and what it may do. Keys are stored hashed in SQL (D1 on Workers, SQLite in tests). Built to be
shared by bench and proxy, the way email-auth is shared for email sign-in.

The library owns everything about keys: format, storage, the bearer check, scopes, the admin routes, the admin CLI and
the client side. The app decides which routes need which scope, and what a key's owner may see.

### 1. The flow

```
admin CLI                       app (with api-key-auth)                  consumer
  | POST /api/keys {name,…}    ->|                                          |
  |   Bearer <admin key>         | constant-time check of the admin key     |
  |<- { id, name, scopes, key } -| store SHA-256(key), return key once      |
  |                                                                          |
  |                              |<- POST /api/push, Bearer <key> ----------|
  |                              | find by SHA-256, not revoked,            |
  |                              | scope of the route granted? else 403     |
  |                              | provide CurrentApiKey to the handler ---->|
```

### 2. Keys

- A key is 32 random bytes (Web Crypto) in base64url, 43 characters, with an optional prefix set by the app:
  `ApiKeyAuth.layer(api, { prefix: "pxy_" })` gives `pxy_<43 chars>`. No prefix by default.
- Shown once, in the answer to its creation. Only its SHA-256, in hex, is stored.
- A key has: `id` (UUID), `name` (a label, not unique), `email` (optional, e.g. to find someone's keys later, as bench's
  UI does), `scopes`, `created_at`, `last_used_at`, `revoked_at`.
- A revoked key stays in the table, so `list` shows it, and answers 401.
- `last_used_at` is written by the bearer check, at most once a minute per key, so a busy key costs one write a
  minute, not one per request. A request refused (401, 403) doesn't count as a use.
- `email` is trimmed and lowercased, as email-auth does, so it can be matched against a signed-in email; by the
  `ApiKeys` service too, for apps that call it directly.

### 3. Scopes

- A key holds a list of scopes, e.g. `["push"]` or `["push", "images"]`. A scope is a short lowercase name.
- `all` is reserved: a key with it may call every route, including routes and scopes added later.
- Routes say which scope they need with an annotation, on all the routes of a set or on one endpoint:
  ```ts
  class PushRoutes extends HttpApiGroup.make("push")
    .add(HttpApiEndpoint.post("notify", "/api/push", { … }))
    .middleware(ApiKeyAuth.Bearer)
    .annotate(ApiKeyAuth.Scope, "push") {}
  ```
  The bearer middleware reads it (the endpoint's annotation first, then its routes'), so handlers never check scopes.
  A route without a `Scope` annotation needs only a valid key.
- A key without the scope gets 403 `Forbidden`.
- `create` accepts only the scopes the app lists in its options, and `all`; any other is 400 `UnknownScope`
  `{ scope }`. Duplicates are dropped.

### 4. Naming

Exports never use the word "group": a set of endpoints is "routes" (`ApiKeyRoutes`, `PushRoutes` in the docs), even
though it is an `HttpApiGroup` underneath.

### 5. HTTP

Admin routes, `ApiKeyRoutes` (the `apiKeys` set, so a typed client calls `client.apiKeys.create(…)`), behind
`ApiKeyAuth.Admin` (bearer admin key, compared with `Mac.timingSafeEqual` from `effect/crypto` over the SHA-256 of both
sides, so lengths don't leak; an empty bearer is always 401):

- `POST   /api/keys`      `{ name, email?, scopes }` → `{ id, name, email, scopes, created_at, key }`
- `GET    /api/keys`      → every key, revoked ones included, oldest first, never the hash; `?email=` filters
  (normalized like `email`)
- `POST   /api/keys/:id/revoke`  sets `revoked_at`, 204: the key answers 401 and stays listed; an unknown id is 404;
  revoking again keeps the first `revoked_at`
- `DELETE /api/keys/:id`  deletes the row, 204: the key answers 401 and leaves the list; an unknown id is 404. For
  keys that shouldn't stay listed, e.g. an app's live tests'.

A key in JSON: `{ id, name, email, scopes, created_at, last_used_at, revoked_at }`, with `null` for an absent email or
time, and times as ISO 8601 strings. `name` is 1 to 200 characters, `scopes` at least one.

The paths' prefix is configurable (`/api` by default): `makeApiKeyRoutes("/admin")` gives the same routes under
`/admin/keys`, and `ApiKeyRoutes` is `makeApiKeyRoutes("/api")`.

Consumer routes are the app's own, behind `ApiKeyAuth.Bearer`, which provides `CurrentApiKey`
(`{ id, name, email, scopes, created_at }`).

The two kinds of key are never interchangeable: a consumer key on `ApiKeyRoutes` and the admin key on the app's routes
both get 401.

Errors: `Unauthorized` 401 (missing, unknown or revoked key; no detail), `Forbidden` 403 `{ scope }`, `NotFound` 404
`{ id }`, `UnknownScope` 400 `{ scope }`.

### 6. Using it in an app

```ts
// api.ts
import { ApiKeyAuth, ApiKeyRoutes } from "api-key-auth"

class PushRoutes extends HttpApiGroup.make("push")
  .add(HttpApiEndpoint.post("notify", "/api/push", { payload: Notify }))
  .middleware(ApiKeyAuth.Bearer)
  .annotate(ApiKeyAuth.Scope, "push") {}

export class ProxyApi extends HttpApi.make("proxy").add(ApiKeyRoutes).add(PushRoutes) {}

// worker.ts
const apiKeyAuth = ApiKeyAuth.layer(ProxyApi, {
  adminKey: Config.Redacted("PROXY_ADMIN_API_KEY"),
  prefix: "pxy_",           // optional
  scopes: ["push", "images"], // the scopes `create` accepts, besides `all`
})

const routes = HttpApiBuilder.layer(ProxyApi).pipe(
  Layer.provide(pushHandlers),
  Layer.provide(apiKeyAuth),
  Layer.provide(D1Client.layer({ db })),
)
```

- `ApiKeyAuth.layer(api, options)` provides the `ApiKeyRoutes` handlers, both middlewares and `ApiKeys`, and needs a
  `SqlClient` on a database whose migrations include the library's (section 9). A compile error, naming the problem, when the `HttpApi` lacks `ApiKeyRoutes`. Middleware the app adds
  to its whole API (a rate limit) wraps `ApiKeyRoutes` too, and must be provided, as in email-auth.
- An app that doesn't want the admin routes (bench's self-serve sign-up) can skip `ApiKeyRoutes` and use
  `ApiKeyAuth.layerBearer({ prefix?, scopes? })` alone, which provides `Bearer` and the `ApiKeys` service for its own
  handlers: `ApiKeys.create({ name, email?, scopes })`, `list({ email? })`, `revoke(id)`, `delete(id)`, `findByKey(key)` (the key's
  record, revoked or not, as an `Option`).
- Handlers read the caller with `yield* CurrentApiKey`.

### 7. Client

```ts
ApiKeyAuth.layerClient(apiKey)  // HttpApiMiddleware.layerClient for Bearer: adds `Authorization: Bearer <key>`
ApiKeyAuth.layerAdminClient(adminKey)
```

An app's own `HttpApiClient` provides these, so its typed client sends the key with no extra code. Neither is required
by the client's type: a consumer's client provides only `layerClient`, and calls to routes whose middleware it lacks go
out without a key, and get 401.

### 8. Admin CLI

An `effect/cli` command the app adds to its own CLI, from `api-key-auth/cli`:

```ts
import { keysCommand } from "api-key-auth/cli"

const keys = keysCommand({
  api: ProxyApi,
  url: ProxyUrl.resolve,             // Effect<string>, e.g. an effect-lib Credentials secret
  adminKey: ProxyAdminApiKey.resolve, // Effect<Redacted<string>>
  keyring: Credentials.bunKeyring(),  // optional, for `create --keyring`: { get, set } by entry name
})
Command.withSubcommands(proxy, [keys])
// …and the app provides an HttpClient: Effect.provide(FetchHttpClient.layer)
```

- `<app> keys create <name> [--email <email>] --scope push [--scope images] | --scope all`: prints the key once,
  alone on stdout, so it pipes (`| cpass …`); everything else on stderr. With `--keyring <NAME>` (e.g.
  `PROXY_API_KEY`), it saves the key in the keyring the app passed, under that name, and prints nothing on stdout. The
  name must look like an environment variable and be free: both are checked before the key is created, and a taken
  name is never replaced. If saving fails after the key exists, the key is printed instead, and the command fails.
- `<app> keys list [--email <email>]`: a table on stdout (id, name, email, scopes, created, last used, status),
  revoked keys marked.
- `<app> keys revoke <id>` and `<app> keys delete <id>`: confirm on stderr.
- `<app> keys migrations new <dir>` and `<app> keys migrations check <dir>`: the library's migration files in the app's
  folder (section 9). They work on files only, without calling the app.

The library takes the url, admin key and keyring from the app, so it doesn't depend on effect-lib; the app passes its secrets.
The command calls the app through the `HttpClient` the app provides, so it chooses the transport, e.g.
`FetchHttpClient.layer`. A failed call is a `KeysCommandError` whose one-line message
(`https://… refused the admin key`) `Command.run` prints.

### 9. Schema: migration files in the app

The library's table is `api_key_auth_keys`. An app may add its own nullable columns to it; the library only reads its
own. The library never touches the schema at runtime: no install, no check. The app's migrations create the table,
from files the library writes:

- `<app> keys migrations new <dir>` writes one `NNNN_api_key_auth_vN.sql` per version without a file in `<dir>`,
  numbered after the folder's last numbered file (`0003_api_key_auth_v1.sql` after bench's `0002_…`), and creates
  `<dir>` if needed. With every version there, it writes nothing. The app's migration tool (alchemy) applies them on
  deploy, in order with the app's own, so an app migration can copy rows into the table or reference it.
- `<app> keys migrations check <dir>` fails, in one line, when a version has no file (naming the versions and
  `keys migrations new`) or a file no longer holds what `new` wrote; for CI or the app's tests.
- Both refuse a folder whose library files, in name order (the order they run in), aren't v1, v2, … once each: a
  version twice, or one before a version it needs (v2 left after v1 was deleted).
- Upgrading: bump the library, run `keys migrations new`, deploy. A forgotten step shows as SQL errors from the new
  code, or a failing `check`.
- The versions: 1 creates `api_key_auth_keys`; 2 adds an index on `email`. A version's file is a header comment and its
  statements, each ending with `;`. A shipped version is never edited; a change is the next version. Alchemy refuses an
  applied file whose contents changed, too.
- The table: `id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT,
  scopes TEXT NOT NULL` (a JSON array), `created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER`
  (milliseconds since the epoch).
- Everything about the schema is in `src/Schema.ts` (the versions, file names and contents); the commands in `cli.ts`.

Considered and dropped: installing at runtime (adds a read per cold start and runs after deploy, too late for bench's
data migration); its own D1 database with an exported migrations folder (alchemy takes one folder per database, and
bench joins its jobs with the keys); SQL copied by hand from the docs (the same files, with more mistakes).

### 10. Package

- Repo `github:laroccacharly/api-key-auth`, used as `bun add github:laroccacharly/api-key-auth#v0.2.0`.
- `effect` (`^4.1.2`) as a peer dependency, pinned in dev dependencies. No other runtime dependency; `@effect/sql-d1`
  isn't one either: a D1 client is told apart by its `batch` method.
- Exports: `.` (server, schemas, client middlewares) and `./cli` (the admin CLI), so a Worker bundle never pulls in the
  CLI.
- Layout, as email-auth: `src/index.ts` (exports), `ApiKeyAuth.ts` (layers, middlewares, client layers),
  `ApiKeyRoutes.ts`, `ApiKey.ts` (schemas), `Middleware.ts` (`Bearer`, `Admin`, `Scope`, `CurrentApiKey`),
  `ApiKeys.ts`, `KeyStore.ts` (the table), `Key.ts` (format and hash), `Schema.ts` (the migrations), `Errors.ts`, `cli.ts`.
- TypeScript source, imported directly, no build step.
- `bun run lint` (oxlint with type checking, then `ts-lint-effect` from `github:laroccacharly/ts-lint`), `bun test`.

### 11. Testing

Through the public API only, in memory, all under 20 seconds:

- A test `HttpApi` with `ApiKeyRoutes` and two scoped routes, served with `HttpRouter.toWebHandler` over
  `@effect/sql-sqlite-bun` in memory, driven by the library's own clients.
- Schema: the test app's tables come from the files `keys migrations new` writes, applied in order, so every case runs
  on them. On a temporary folder: `new` writes every version into an empty (or missing) folder, numbers its files
  after the app's own, writes nothing a second time, and writes only a missing version; `check` passes after `new`,
  and names a missing version or an edited file; both refuse a version twice or out of order.
- Cases: create returns a key once, list never shows a hash; the key opens a route with its scope; the prefix is
  applied when set and absent by default; `all` opens every route; a missing scope is 403; no key, a wrong key, a
  revoked key and a deleted key are 401; the admin key on a consumer route and a consumer key on `ApiKeyRoutes` are 401; `email` is
  normalized and filters `list`; `last_used_at` moves, at most once a minute (with `TestClock`).
- The CLI against the same in-memory server: create prints only the key on stdout; `create --keyring` saves it, refuses
  a taken or malformed name or an app without a keyring before creating a key, and prints the key when saving fails; list; revoke; delete; a wrong admin key
  fails with a message.
- `layerBearer` alone, with keys created in the app's own handler, as bench will; `ApiKeyAuth.layer` on an `HttpApi`
  without `ApiKeyRoutes` is a compile error.

### 12. Consumers

- **proxy**: phase 2 of its `docs/migration.md` becomes wiring this in, with `prefix: "pxy_"` and scopes
  `push` and `images`; its planned `0001_api_keys.sql` is replaced by the files `proxy keys migrations new` writes.
- **bench**: its `api_keys` table moves to the library's: `keys migrations new ./migrations` writes
  `0003_api_key_auth_v1.sql` and `0004_api_key_auth_v2.sql`, then bench's own `0005` copies `id, key_hash, name,
  email, created_at` with scopes `["all"]`; its open `POST /api/api-keys` calls `ApiKeys.create`, and it gains list and revoke
  through an admin key. Existing keys keep working: the hash is the same.
