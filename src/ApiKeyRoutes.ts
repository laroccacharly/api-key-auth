import { Schema } from "effect"
import type { PathInput } from "effect/http/HttpRouter"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { ApiKey, CreatedApiKey, Email, NewApiKey } from "./ApiKey.ts"
import { NotFound, UnknownScope } from "./Errors.ts"
import { Admin } from "./Middleware.ts"

/** The `apiKeys` routes under `prefix`, behind the admin key: `ApiKeyRoutes` is them under `/api`. */
export const makeApiKeyRoutes = <const Prefix extends PathInput>(prefix: Prefix) =>
  HttpApiGroup.make("apiKeys")
    .add(
      HttpApiEndpoint.post("create", "/keys", { payload: NewApiKey, success: CreatedApiKey, error: UnknownScope }),
      HttpApiEndpoint.get("list", "/keys", { query: { email: Schema.optionalKey(Email) }, success: Schema.Array(ApiKey) }),
      HttpApiEndpoint.post("revoke", "/keys/:id/revoke", { params: { id: Schema.String }, success: HttpApiSchema.NoContent, error: NotFound }),
      HttpApiEndpoint.delete("delete", "/keys/:id", { params: { id: Schema.String }, success: HttpApiSchema.NoContent, error: NotFound }),
    )
    .middleware(Admin)
    .prefix(prefix)

/** The admin routes, added by the app to its `HttpApi`: create, list, revoke and delete keys under `/api/keys`. */
export class ApiKeyRoutes extends makeApiKeyRoutes("/api") {}

// The library's code is typed against this API; at runtime it uses the app's, whose prefix and annotations it reads.
export const ApiKeyAuthApi = HttpApi.make("api-key-auth").add(ApiKeyRoutes)

/** The app's `apiKeys` routes: `ApiKeyRoutes`, with any middleware the app added to its whole `HttpApi`. */
export type ApiKeyRoutesOf<Groups> = Extract<Groups, { readonly identifier: "apiKeys" }>

/** A compile error, naming the problem, for an `HttpApi` without `ApiKeyRoutes`. */
export type RequireApiKeyRoutes<Groups> = [ApiKeyRoutesOf<Groups>] extends [never] ? { readonly "the HttpApi must add ApiKeyRoutes": never } : object
