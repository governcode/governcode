# Contributing

Thanks for looking. GovernCode is early (phase 0), so issues and design discussion are the
most useful contributions right now.

## Ground rules

- **Security first.** The sandbox's guarantees are in [docs/SANDBOX.md](docs/SANDBOX.md).
  A change that weakens an invariant needs a very good reason and a self-test update.
- **Fail closed.** If something cannot be enforced, refuse and say why. No "run without
  the sandbox" switches.
- **Small, readable changes**, with a test that would fail without them.
- **No agent instruction files** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/` and
  similar) in this repository.
- **No personal data** in code, tests or docs: use temp dirs, `$HOME`, and documentation
  addresses (192.0.2.x) in examples.

## AI assistance

This project is built with heavy AI assistance and says so (see the README). If you use AI
tools, say so in your pull request description: which tool, and for what. Please do not
add AI co-author trailers to commit messages; credit is kept in the README.

## Checks

```
npm ci
npm run typecheck && npm test
cargo build --release && cargo test --release
./target/release/govern-sup selftest
```

CI runs the same on Linux.
