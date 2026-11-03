`api-key-auth.md` is the design: keep it in sync with the code.

- `bun test` (in memory, through the public API) and `bun run lint` must pass.
- Follow `../email-auth` for layout, style, lint and test setup. `../bench` and `../proxy` are the consumers.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
