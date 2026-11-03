import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Option, Redacted } from "effect"
import { adminKey, baseUrl, makeTestApp, type TestApp, unknownKey } from "./app.ts"

let app: TestApp

afterEach(() => app.dispose())

const admin = () => app.client({ admin: adminKey })

const createKey = (payload: { readonly name: string; readonly email?: string; readonly scopes: readonly [string, ...Array<string>] }) =>
  app.run(Effect.flatMap(admin(), (client) => client.apiKeys.create({ payload })))

const listKeys = (query: { readonly email?: string } = {}) => app.run(Effect.flatMap(admin(), (client) => client.apiKeys.list({ query })))

const revokeKey = (id: string) => app.outcome(Effect.flatMap(admin(), (client) => client.apiKeys.revoke({ params: { id } })))

const pushWith = (credentials: { readonly key?: string }) => app.outcome(Effect.flatMap(app.client(credentials), (client) => client.push.notify()))

const push = (key: string) => pushWith({ key })

const generateImage = (key: string) => app.outcome(Effect.flatMap(app.client({ key }), (client) => client.images.generate()))

const whoami = (key: string) => app.run(Effect.flatMap(app.client({ key }), (client) => client.images.whoami()))

describe("creating and listing keys", () => {
  test("create returns the key once, and list never shows it or its hash", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "laptop", scopes: ["push"] })
    expect(created.key).toMatch(/^[\w-]{43}$/)
    expect(created.name).toBe("laptop")
    expect(created.scopes).toEqual(["push"])

    const response = await app.fetch(`${baseUrl}/api/keys`, { headers: { authorization: `Bearer ${Redacted.value(adminKey)}` } })
    const body = await response.text()
    expect(body).toContain(created.id)
    expect(body).not.toContain(created.key)
    expect(body).not.toContain("hash")
    expect(response.headers.get("x-stamp")).toBe("app")
  })

  test("the prefix is put before the key when set", async () => {
    app = await makeTestApp({ prefix: "pxy_" })
    const created = await createKey({ name: "laptop", scopes: ["push"] })
    expect(created.key).toMatch(/^pxy_[\w-]{43}$/)
    expect(await push(created.key)).toBe("ok")
  })

  test("a scope the app doesn't accept is refused", async () => {
    app = await makeTestApp()
    const outcome = await app.outcome(Effect.flatMap(admin(), (client) => client.apiKeys.create({ payload: { name: "x", scopes: ["mail"] } })))
    expect(outcome).toBe("UnknownScope")
  })

  test("the email is normalized, and filters list", async () => {
    app = await makeTestApp()
    const response = await app.fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${Redacted.value(adminKey)}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "mine", email: "  Me@Example.COM ", scopes: ["push"] }),
    })
    const mine = await response.json()
    await createKey({ name: "theirs", email: "you@example.com", scopes: ["push"] })
    await createKey({ name: "nobody's", scopes: ["push"] })
    expect(mine.email).toBe("me@example.com")

    expect((await listKeys()).map((key) => key.name).toSorted()).toEqual(["mine", "nobody's", "theirs"])
    expect((await listKeys({ email: "ME@example.com" })).map((key) => key.id)).toEqual([mine.id])
  })

  test("the admin routes can live under another prefix", async () => {
    app = await makeTestApp({ adminPrefix: true })
    const auth = { authorization: `Bearer ${Redacted.value(adminKey)}` }
    expect((await app.fetch(`${baseUrl}/admin/keys`, { headers: auth })).status).toBe(200)
    expect((await app.fetch(`${baseUrl}/api/keys`, { headers: auth })).status).toBe(404)
  })
})

describe("scopes", () => {
  test("a key opens the routes of its scope, and is told who it is", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "laptop", scopes: ["push"] })
    expect(await push(created.key)).toBe("ok")
    expect(await whoami(created.key)).toEqual({ name: "laptop", scopes: ["push"] })
  })

  test("a missing scope is 403, on a set of routes or on one endpoint", async () => {
    app = await makeTestApp()
    const pushOnly = await createKey({ name: "a", scopes: ["push"] })
    const imagesOnly = await createKey({ name: "b", scopes: ["images"] })
    expect(await generateImage(pushOnly.key)).toBe("Forbidden")
    expect(await push(imagesOnly.key)).toBe("Forbidden")
    expect(await generateImage(imagesOnly.key)).toBe("ok")

    const response = await app.fetch(`${baseUrl}/api/push`, { method: "POST", headers: { authorization: `Bearer ${imagesOnly.key}` } })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ scope: "push" })
  })

  test("all opens every route", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "root", scopes: ["all"] })
    expect(await push(created.key)).toBe("ok")
    expect(await generateImage(created.key)).toBe("ok")
  })

  test("a route without a scope needs only a valid key", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "b", scopes: ["images"] })
    expect((await whoami(created.key)).name).toBe("b")
  })
})

describe("unauthorized", () => {
  test("no key, an unknown key, and a revoked key are 401", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "laptop", scopes: ["push"] })
    expect(await pushWith({})).toBe("Unauthorized")
    expect(await push(unknownKey())).toBe("Unauthorized")

    expect(await revokeKey(created.id)).toBe("ok")
    expect(await push(created.key)).toBe("Unauthorized")
    const [revoked] = await listKeys()
    expect(Option.isSome(revoked!.revoked_at)).toBe(true)
  })

  test("a deleted key is 401 and leaves the list; deleting an unknown id is 404", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "laptop", scopes: ["push"] })
    expect(await app.outcome(Effect.flatMap(admin(), (client) => client.apiKeys.delete({ params: { id: created.id } })))).toBe("ok")
    expect(await push(created.key)).toBe("Unauthorized")
    expect(await listKeys()).toEqual([])
    expect(await app.outcome(Effect.flatMap(admin(), (client) => client.apiKeys.delete({ params: { id: created.id } })))).toBe("NotFound")
  })

  test("POST /api/keys/:id/revoke keeps the key listed, DELETE /api/keys/:id removes it", async () => {
    app = await makeTestApp()
    const revoked = await createKey({ name: "revoked", scopes: ["push"] })
    const deleted = await createKey({ name: "deleted", scopes: ["push"] })
    const auth = { authorization: `Bearer ${Redacted.value(adminKey)}` }
    expect((await app.fetch(`${baseUrl}/api/keys/${revoked.id}/revoke`, { method: "POST", headers: auth })).status).toBe(204)
    expect((await app.fetch(`${baseUrl}/api/keys/${deleted.id}`, { method: "DELETE", headers: auth })).status).toBe(204)
    expect((await listKeys()).map((key) => key.name)).toEqual(["revoked"])
  })

  test("revoking an unknown id is 404", async () => {
    app = await makeTestApp()
    expect(await revokeKey("no-such-id")).toBe("NotFound")
  })

  test("the admin key on a consumer route, and a consumer key on the admin routes, are 401", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "root", scopes: ["all"] })
    expect(await push(Redacted.value(adminKey))).toBe("Unauthorized")
    const asConsumer = await app.outcome(Effect.flatMap(app.client({ admin: Redacted.make(created.key) }), (client) => client.apiKeys.list({ query: {} })))
    expect(asConsumer).toBe("Unauthorized")
  })

  test("no admin key, or a wrong one, is 401", async () => {
    app = await makeTestApp()
    expect((await app.fetch(`${baseUrl}/api/keys`)).status).toBe(401)
    const wrong = await app.fetch(`${baseUrl}/api/keys`, { headers: { authorization: "Bearer the-admin-key-of-the-test-ap" } })
    expect(wrong.status).toBe(401)
  })
})

describe("last_used_at", () => {
  const lastUsedOf = async (id: string) => {
    const apiKey = (await listKeys()).find((key) => key.id === id)
    return Option.getOrUndefined(apiKey!.last_used_at)?.epochMilliseconds
  }

  test("moves on use, at most once a minute", async () => {
    app = await makeTestApp()
    const created = await createKey({ name: "laptop", scopes: ["push"] })
    expect(await lastUsedOf(created.id)).toBeUndefined()

    await push(created.key)
    expect(await lastUsedOf(created.id)).toBe(0)

    await app.advance("30 seconds")
    await push(created.key)
    expect(await lastUsedOf(created.id)).toBe(0)

    await app.advance("31 seconds")
    await push(created.key)
    expect(await lastUsedOf(created.id)).toBe(61_000)
  })
})
