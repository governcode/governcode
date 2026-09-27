# Security

GovernCode's job is to keep AI tools inside a sandbox and behind your approval, so
security reports are very welcome.

## Reporting

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/governcode/governcode/security/advisories/new),
not in a public issue. Include what you did, what you expected, and what happened.

Especially interesting: any way for a sandboxed tool to reach `govd` other than its own
pipes, answer or forge a Gate, read GovernCode's state or the user's keyrings, widen its
own permissions for a later run, or start another AI tool outside the sandbox.

## Status

Pre-alpha. There are no releases yet, so fixes land on `main`.
