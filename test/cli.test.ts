import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Redacted } from "effect"
import { makeTestApp, runKeysCommand, type TestApp } from "./app.ts"

let app: TestApp

afterEach(() => app.dispose())

const push = (key: string) => app.outcome(Effect.flatMap(app.client({ key }), (client) => client.push.notify()))

const createWithCli = async (name: string, ...flags: Array<string>) => {
  const { stdout } = await runKeysCommand(app, ["create", name, ...flags])
  return stdout.join("\n")
}

/** The id of the key named `name`, read from the table `list` prints. */
const idOf = async (name: string) => {
  const { stdout } = await runKeysCommand(app, ["list"])
  const line = stdout.join("\n").split("\n").find((row) => row.split(/\s+/u)[1] === name)
  return line?.split(" ")[0] ?? ""
}

test("create prints the key alone on stdout, and it works", async () => {
  app = await makeTestApp()
  const { exit, stdout, stderr } = await runKeysCommand(app, ["create", "laptop", "--email", "me@example.com", "--scope", "push", "--scope", "images"])
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(stdout).toHaveLength(1)
  expect(stdout[0]).toMatch(/^[\w-]{43}$/)
  expect(stderr.join("\n")).toContain("laptop")
  expect(await push(stdout[0]!)).toBe("ok")
})

test("list prints a table, revoked keys marked", async () => {
  app = await makeTestApp()
  await createWithCli("laptop", "--scope", "push")
  await createWithCli("phone", "--email", "me@example.com", "--scope", "all")
  await runKeysCommand(app, ["revoke", await idOf("laptop")])

  const { stdout } = await runKeysCommand(app, ["list"])
  const lines = stdout.join("\n").split("\n")
  expect(lines[0]).toMatch(/^ID\s+NAME\s+EMAIL\s+SCOPES\s+CREATED\s+LAST USED\s+STATUS$/u)
  expect(lines.find((line) => line.includes("laptop"))).toContain("revoked")
  expect(lines.find((line) => line.includes("phone"))).toContain("active")

  const mine = await runKeysCommand(app, ["list", "--email", "me@example.com"])
  expect(mine.stdout.join("\n")).not.toContain("laptop")
})

test("revoke makes the key answer 401", async () => {
  app = await makeTestApp()
  const key = await createWithCli("laptop", "--scope", "push")
  const { exit, stdout } = await runKeysCommand(app, ["revoke", await idOf("laptop")])
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(stdout).toEqual([])
  expect(await push(key)).toBe("Unauthorized")
})

test("a wrong admin key fails with a message, and prints no key", async () => {
  app = await makeTestApp()
  const { exit, stdout } = await runKeysCommand(app, ["create", "laptop", "--scope", "push"], Redacted.make("not-the-admin-key"))
  expect(stdout).toEqual([])
  expect(Exit.isFailure(exit)).toBe(true)
  expect(String(exit)).toContain("refused the admin key")
})
