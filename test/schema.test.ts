import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Exit } from "effect"
import { runMigrationsCommand } from "./app.ts"

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "api-key-auth-"))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

const names = () => readdirSync(directory).toSorted()

/** The app's own migrations, as bench's folder has them. */
const writeAppMigrations = () => {
  writeFileSync(join(directory, "0001_api_keys_and_jobs.sql"), "CREATE TABLE jobs (id TEXT PRIMARY KEY);\n")
  writeFileSync(join(directory, "0002_api_keys_email.sql"), "CREATE INDEX jobs_id ON jobs (id);\n")
}

test("new writes every version into an empty folder, and creates it", async () => {
  const folder = join(directory, "migrations")
  const { exit, stdout } = await runMigrationsCommand(["new", folder])
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(stdout).toEqual([])
  expect(readdirSync(folder).toSorted()).toEqual(["0001_api_key_auth_v1.sql", "0002_api_key_auth_v2.sql"])
  expect(readFileSync(join(folder, "0001_api_key_auth_v1.sql"), "utf8")).toContain("CREATE TABLE api_key_auth_keys")
})

test("new numbers its files after the app's own, and a second run writes nothing", async () => {
  writeAppMigrations()
  await runMigrationsCommand(["new", directory])
  expect(names()).toEqual([
    "0001_api_keys_and_jobs.sql",
    "0002_api_keys_email.sql",
    "0003_api_key_auth_v1.sql",
    "0004_api_key_auth_v2.sql",
  ])
  const { exit, stderr } = await runMigrationsCommand(["new", directory])
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(stderr.join("\n")).toContain("has every api-key-auth migration")
  expect(names()).toHaveLength(4)
})

test("new writes only the versions missing, after the last file", async () => {
  writeAppMigrations()
  await runMigrationsCommand(["new", directory])
  unlinkSync(join(directory, "0004_api_key_auth_v2.sql"))
  writeFileSync(join(directory, "0004_jobs_name.sql"), "ALTER TABLE jobs ADD COLUMN name TEXT;\n")
  await runMigrationsCommand(["new", directory])
  expect(names()).toContain("0005_api_key_auth_v2.sql")
  expect(names()).toHaveLength(5)
})

test("check passes once new has run", async () => {
  writeAppMigrations()
  await runMigrationsCommand(["new", directory])
  const { exit } = await runMigrationsCommand(["check", directory])
  expect(Exit.isSuccess(exit)).toBe(true)
})

test("check names the versions missing, and the command that writes them", async () => {
  writeAppMigrations()
  await runMigrationsCommand(["new", directory])
  unlinkSync(join(directory, "0004_api_key_auth_v2.sql"))
  const { exit } = await runMigrationsCommand(["check", directory])
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("lacks api-key-auth v2")
  expect(String(exit)).toContain("keys migrations new")
})

test("check names a file that was edited", async () => {
  await runMigrationsCommand(["new", directory])
  writeFileSync(join(directory, "0001_api_key_auth_v1.sql"), "CREATE TABLE api_key_auth_keys (id TEXT);\n")
  const { exit } = await runMigrationsCommand(["check", directory])
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("0001_api_key_auth_v1.sql")
})

test("check fails on a folder that doesn't exist", async () => {
  const { exit } = await runMigrationsCommand(["check", join(directory, "missing")])
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("lacks api-key-auth v1, v2")
})

test("new and check refuse a version twice, or one before the version it needs", async () => {
  await runMigrationsCommand(["new", directory])
  writeFileSync(join(directory, "0003_api_key_auth_v1.sql"), readFileSync(join(directory, "0001_api_key_auth_v1.sql")))
  const twice = await runMigrationsCommand(["check", directory])
  expect(String(twice.exit)).toContain("0003_api_key_auth_v1.sql is out of place")

  unlinkSync(join(directory, "0001_api_key_auth_v1.sql"))
  unlinkSync(join(directory, "0003_api_key_auth_v1.sql"))
  const { exit } = await runMigrationsCommand(["new", directory])
  expect(String(exit)).toContain("0002_api_key_auth_v2.sql is out of place")
  expect(names()).toEqual(["0002_api_key_auth_v2.sql"])
})
