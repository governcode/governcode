# Contributing

Thanks for looking. GovernCode is early (pre-alpha), so issues and design discussion are the
most useful contributions right now. Pull requests go to the `debate` branch.

## Ground rules

- **Respect, always.** Talk about code, designs and ideas, never about people or the tools
  and systems they like. See the [code of conduct](https://github.com/governcode/.github/blob/main/CODE_OF_CONDUCT.md)
  and [what we stand for](docs/PHILOSOPHY.md).
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
tools too, that's welcome: mention it in your pull request if you like, and AI co-author
trailers in your own commits are fine.

## Checks

```
npm ci
npm run typecheck && npm test
cargo build --release && cargo test --release
./target/release/govern-sup selftest
```

CI runs the same on Linux.
