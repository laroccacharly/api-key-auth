import { Context } from "effect"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import type { CallingApiKey } from "./ApiKey.ts"
import { Forbidden, Unauthorized } from "./Errors.ts"

/** The key that called, provided by `Bearer` to the handlers of the routes it protects. */
export class CurrentApiKey extends Context.Service<CurrentApiKey, CallingApiKey>()("api-key-auth/CurrentApiKey") {}

/**
 * The scope a route needs, annotated on its endpoint or on all the routes of a set:
 * `.annotate(ApiKeyAuth.Scope, "push")`. A route without it needs only a valid key.
 */
export class Scope extends Context.Service<Scope, string>()("api-key-auth/Scope") {}

/** A consumer key as a bearer token: 401 without a valid one, 403 without the route's scope. */
export class Bearer extends HttpApiMiddleware.Service<Bearer, {
  provides: CurrentApiKey
}>()("api-key-auth/Bearer", {
  security: { bearer: HttpApiSecurity.bearer },
  error: [Unauthorized, Forbidden],
}) {}

/** The admin key as a bearer token, on `ApiKeyRoutes`: 401 for anything else, consumer keys included. */
export class Admin extends HttpApiMiddleware.Service<Admin>()("api-key-auth/Admin", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized,
}) {}
