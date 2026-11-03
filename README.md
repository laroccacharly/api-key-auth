# api-key-auth

API keys for Effect `HttpApi` servers. An admin creates a key, a consumer sends it as a bearer token, and each route
says which scope it needs. Keys are stored hashed in SQL (D1 on Workers, SQLite elsewhere), in tables the app's
migrations create from files the library writes. It also ships the admin routes, an admin CLI command and the client middlewares.

## Requirements

- `effect` 4.1.2 or later
- A SQL client from `effect/sql`, e.g. `@effect/sql-d1`
- Bun or Cloudflare Workers (any runtime with Web Crypto)

## Installation

```sh
bun add github:laroccacharly/api-key-auth#v0.2.0
```
