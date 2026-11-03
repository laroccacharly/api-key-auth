import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redacted } from "effect"
import { adminKey, baseUrl, makeTestApp, type TestApp } from "./app.ts"

let directory: string
let filename: string
const apps: Array<TestApp> = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "api-key-auth-"))
  filename = join(directory, "app.sqlite")
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.dispose()))
  rmSync(directory, { recursive: true, force: true })
})

const startApp = async () => {
  const app = await makeTestApp({ filename })
  apps.push(app)
  return app
}

const asAdmin = { headers: { authorization: `Bearer ${Redacted.value(adminKey)}` } }

const listKeys = (app: TestApp) => app.fetch(`${baseUrl}/api/keys`, asAdmin)

const push = (app: TestApp, key: string) => app.fetch(`${baseUrl}/api/push`, { method: "POST", headers: { authorization: `Bearer ${key}` } })

/** What the database says about the library's schema, read beside the app. */
const inspect = () => {
  const database = new Database(filename, { readonly: true })
  const versions = database.query<{ version: number }, []>("SELECT version FROM api_key_auth_schema ORDER BY version").all().map((row) => row.version)
  const indexes = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'api_key_auth_keys_email'").all()
  database.close()
  return { versions, hasEmailIndex: indexes.length === 1 }
}

const sha256Hex = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

/** A database as version 1 of the library left it, with a key copied in from elsewhere, as bench's migration does. */
const writeVersion1Database = (key: string) => {
  const database = new Database(filename, { create: true })
  database.run(`CREATE TABLE api_key_auth_keys (
    id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT, scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
  )`)
  database.run("CREATE TABLE api_key_auth_schema (version INTEGER PRIMARY KEY, installed_at INTEGER NOT NULL)")
  database.run("INSERT INTO api_key_auth_schema VALUES (1, 0)")
  database.run("INSERT INTO api_key_auth_keys (id, key_hash, name, email, scopes, created_at) VALUES ('old', ?, 'old key', NULL, '[\"all\"]', 0)", [sha256Hex(key)])
  database.close()
}

test("a fresh database installs itself before the first query", async () => {
  const app = await startApp()
  expect((await listKeys(app)).status).toBe(200)
  expect(inspect()).toEqual({ versions: [1, 2], hasEmailIndex: true })
})

test("a database at version 1 upgrades, and its keys keep working", async () => {
  writeVersion1Database("bench_an-old-key")
  const app = await startApp()
  expect((await push(app, "bench_an-old-key")).status).toBe(200)
  expect(inspect()).toEqual({ versions: [1, 2], hasEmailIndex: true })
})

test("two cold starts on the same fresh database don't fail", async () => {
  const [first, second] = [await startApp(), await startApp()]
  const responses = await Promise.all([listKeys(first), listKeys(second)])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(inspect().versions).toEqual([1, 2])
})
