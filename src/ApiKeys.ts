import { Context, Effect, Layer, type Option } from "effect"
import type { ApiKey, CreatedApiKey, NewApiKey } from "./ApiKey.ts"
import type { NotFound, UnknownScope } from "./Errors.ts"
import { KeyStore } from "./KeyStore.ts"

/** The keys, for an app's own handlers, e.g. a self-serve sign-up that creates a key without the admin routes. */
export class ApiKeys extends Context.Service<ApiKeys, {
  readonly create: (newKey: NewApiKey) => Effect.Effect<CreatedApiKey, UnknownScope>
  /** Every key, revoked ones included, oldest first; only those of `email` when given. */
  readonly list: (filter?: { readonly email?: string }) => Effect.Effect<ReadonlyArray<ApiKey>>
  readonly revoke: (id: string) => Effect.Effect<void, NotFound>
  /** The key whose plaintext is `key`, revoked or not. */
  readonly findByKey: (key: string) => Effect.Effect<Option.Option<ApiKey>>
}>()("api-key-auth/ApiKeys") {}

export const apiKeysLayer = Layer.effect(
  ApiKeys,
  Effect.gen(function* () {
    const store = yield* KeyStore
    return ApiKeys.of({ create: store.create, list: store.list, revoke: store.revoke, findByKey: store.findByKey })
  }),
)
