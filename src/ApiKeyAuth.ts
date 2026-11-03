import { type Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { Digest, Mac } from "effect/crypto"
import { HttpClientRequest } from "effect/http"
import { type HttpApi, HttpApiBuilder, type HttpApiEndpoint, type HttpApiGroup, HttpApiMiddleware } from "effect/http-api"
import type { SqlClient, SqlError } from "effect/sql"
import { allScope, type ApiKey, type CallingApiKey } from "./ApiKey.ts"
import { type ApiKeyAuthApi, type ApiKeyRoutesOf, type RequireApiKeyRoutes } from "./ApiKeyRoutes.ts"
import { ApiKeys, apiKeysLayer } from "./ApiKeys.ts"
import { Forbidden, Unauthorized } from "./Errors.ts"
import { hashKey } from "./Key.ts"
import { KeyStore, type KeyStoreOptions } from "./KeyStore.ts"
import { Admin, Bearer, CurrentApiKey, Scope } from "./Middleware.ts"

export { Admin, Bearer, Scope }

export interface BearerOptions extends KeyStoreOptions {}

export interface ApiKeyAuthOptions extends KeyStoreOptions {
  /** The key of `ApiKeyRoutes`, e.g. `Config.Redacted("PROXY_ADMIN_API_KEY")`. It opens no other route. */
  readonly adminKey: Config.Config<Redacted.Redacted<string>>
}

/** The scope a route needs: its endpoint's annotation first, then its routes'. */
const requiredScope = (endpoint: HttpApiEndpoint.Top, group: HttpApiGroup.Top) =>
  Option.orElse(Context.getOption(endpoint.annotations, Scope), () => Context.getOption(group.annotations, Scope))

const grants = (scopes: ReadonlyArray<string>, scope: string) => scopes.includes(allScope) || scopes.includes(scope)

const isUsable = (apiKey: Option.Option<ApiKey>): apiKey is Option.Some<ApiKey> => Option.isSome(apiKey) && Option.isNone(apiKey.value.revoked_at)

const callingApiKey = ({ id, name, email, scopes, created_at }: ApiKey): CallingApiKey => ({ id, name, email, scopes, created_at })

const bearerMiddleware = Layer.effect(
  Bearer,
  Effect.gen(function* () {
    const store = yield* KeyStore
    return Bearer.of({
      bearer: Effect.fnUntraced(function* (httpEffect, { credential, endpoint, group }) {
        const apiKey = yield* store.findByKey(Redacted.value(credential))
        if (!isUsable(apiKey)) return yield* new Unauthorized()
        const scope = requiredScope(endpoint, group)
        if (Option.isSome(scope) && !grants(apiKey.value.scopes, scope.value)) return yield* new Forbidden({ scope: scope.value })
        yield* store.markUsed(apiKey.value)
        return yield* Effect.provideService(httpEffect, CurrentApiKey, callingApiKey(apiKey.value))
      }),
    })
  }),
)

/** Compares the SHA-256 of both keys, so the comparison takes the same time whatever their lengths. */
const adminMiddleware = (adminKey: Config.Config<Redacted.Redacted<string>>) =>
  Layer.effect(
    Admin,
    Effect.gen(function* () {
      const digest = yield* Digest.Digest
      const adminHash = yield* hashKey(Redacted.value(yield* adminKey))
      const isAdminKey = (key: string) =>
        Effect.map(hashKey(key), (hash) => key !== "" && Mac.timingSafeEqual(hash, adminHash)).pipe(Effect.provideService(Digest.Digest, digest))
      return Admin.of({
        bearer: Effect.fnUntraced(function* (httpEffect, { credential }) {
          if (!(yield* isAdminKey(Redacted.value(credential)))) return yield* new Unauthorized()
          return yield* httpEffect
        }),
      })
    }),
  ).pipe(Layer.provide(Digest.layerWebCrypto))


const apiKeyRoutesHandlers = (api: typeof ApiKeyAuthApi) =>
  HttpApiBuilder.group(api, "apiKeys", Effect.fnUntraced(function* (handlers) {
    const store = yield* KeyStore
    return handlers.handleAll({
      create: ({ payload }) => store.create(payload),
      list: ({ query }) => store.list(query),
      revoke: ({ params }) => store.revoke(params.id),
    })
  }))


/** The middleware the app put on the `apiKeys` endpoints, and what it needs, which their handlers then need too. */
type AppMiddlewareOf<Groups> = Exclude<
  | HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<ApiKeyRoutesOf<Groups>>>
  | HttpApiEndpoint.MiddlewareServices<HttpApiGroup.Endpoints<ApiKeyRoutesOf<Groups>>>,
  Admin
>

/**
 * `Bearer` and `ApiKeys` without the admin routes, for an app that creates keys in its own handlers. Brings the
 * tables up to date when built.
 */
export const layerBearer = (options: BearerOptions = {}): Layer.Layer<Bearer | ApiKeys, SqlError.SqlError, SqlClient.SqlClient> =>
  Layer.mergeAll(bearerMiddleware, apiKeysLayer).pipe(Layer.provide(KeyStore.layer(options)))

/**
 * The `ApiKeyRoutes` handlers, the `Bearer` and `Admin` middlewares and `ApiKeys`, for an app whose `HttpApi`
 * includes `ApiKeyRoutes`. Middleware the app adds to its whole API runs on `ApiKeyRoutes` too, so the layer needs it
 * provided. Brings the tables up to date when built.
 */
export const layer = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups> & RequireApiKeyRoutes<Groups>,
  options: ApiKeyAuthOptions,
): Layer.Layer<
  HttpApiGroup.Service<ApiId, "apiKeys"> | Bearer | Admin | ApiKeys,
  Config.ConfigError | SqlError.SqlError,
  SqlClient.SqlClient | AppMiddlewareOf<Groups>
> => {
  const handlers = apiKeyRoutesHandlers(api as never as typeof ApiKeyAuthApi) as Layer.Layer<
    HttpApiGroup.Service<ApiId, "apiKeys">,
    never,
    KeyStore | Admin | AppMiddlewareOf<Groups>
  >
  const middlewares = Layer.mergeAll(bearerMiddleware, adminMiddleware(options.adminKey), apiKeysLayer)
  return handlers.pipe(Layer.provideMerge(middlewares), Layer.provide(KeyStore.layer(options)))
}

/** For an app's `HttpApiClient`: sends `apiKey` to the routes behind `Bearer`. */
export const layerClient = (apiKey: Redacted.Redacted<string>) =>
  HttpApiMiddleware.layerClient(Bearer, ({ next, request }) => next(HttpClientRequest.bearerToken(request, apiKey)))

/** For an app's `HttpApiClient`: sends `adminKey` to `ApiKeyRoutes`. */
export const layerAdminClient = (adminKey: Redacted.Redacted<string>) =>
  HttpApiMiddleware.layerClient(Admin, ({ next, request }) => next(HttpClientRequest.bearerToken(request, adminKey)))
