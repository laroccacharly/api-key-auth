import { afterEach, expect, test } from "bun:test"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { ApiKeyAuth, ApiKeys, CreatedApiKey, CurrentApiKey } from "../src/index.ts"
import { migratedSqlite } from "./app.ts"

// An app like bench: anyone signs up for a key with all scopes, and no admin routes.
class SignUpRoutes extends HttpApiGroup.make("signUp")
  .add(HttpApiEndpoint.post("create", "/api/sign-up", { payload: Schema.Struct({ name: Schema.String, email: Schema.String }), success: CreatedApiKey })) {}

class JobsRoutes extends HttpApiGroup.make("jobs")
  .add(HttpApiEndpoint.get("mine", "/api/jobs", { success: Schema.Struct({ owner: Schema.String }) }))
  .middleware(ApiKeyAuth.Bearer)
  .annotate(ApiKeyAuth.Scope, "jobs") {}

class SelfServeApi extends HttpApi.make("self-serve").add(SignUpRoutes).add(JobsRoutes) {}

const signUpHandlers = HttpApiBuilder.group(SelfServeApi, "signUp", Effect.fnUntraced(function* (handlers) {
  const apiKeys = yield* ApiKeys
  return handlers.handle("create", ({ payload }) => Effect.orDie(apiKeys.create({ name: payload.name, email: payload.email, scopes: ["all"] })))
}))

const jobsHandlers = HttpApiBuilder.group(SelfServeApi, "jobs", (handlers) =>
  handlers.handle("mine", () => CurrentApiKey.useSync((apiKey) => ({ owner: apiKey.name }))))

const { handler, dispose } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(SelfServeApi).pipe(
    Layer.provide([signUpHandlers, jobsHandlers]),
    Layer.provide(ApiKeyAuth.layerBearer({ prefix: "bench_" })),
    Layer.provide(migratedSqlite(":memory:")),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
)

afterEach(() => dispose())

test("an app without the admin routes creates keys in its own handlers, and Bearer checks them", async () => {
  const signUp = await handler(new Request("https://app.example/api/sign-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "me", email: "  Me@Example.COM " }),
  }))
  const { key, email } = await signUp.json()
  expect(email).toBe("me@example.com")
  expect(key).toMatch(/^bench_[\w-]{43}$/)

  const jobs = await handler(new Request("https://app.example/api/jobs", { headers: { authorization: `Bearer ${key}` } }))
  expect(await jobs.json()).toEqual({ owner: "me" })
  expect((await handler(new Request("https://app.example/api/jobs"))).status).toBe(401)
})

test("ApiKeyAuth.layer is a compile error for an HttpApi without ApiKeyRoutes", () => {
  // @ts-expect-error the HttpApi must add ApiKeyRoutes
  const layer = ApiKeyAuth.layer(SelfServeApi, { adminKey: Config.succeed(Redacted.make("admin")) })
  expect(layer).toBeDefined()
})
