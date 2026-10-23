# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories:

https://github.com/sildo466/dsh-character-cards/security/advisories/new

Do not open a public issue for a vulnerability.

Include:

- The plugin version and the DSH version.
- Steps to reproduce, or a minimal card file if the issue is in import or rendering.
- What you expected and what happened.

## Scope

The plugin:

- Reads and writes card files under `$DSH_HOME/character-cards/`.
- Exposes HTTP routes under `/dsh-character-cards`, guarded to loopback requests with a matching Host header.
- Treats a card as data. It does not load scripts, plugins, or `!!js` expressions from a card.
- Caps imported files at 1 MB and validates the card id before touching the filesystem.

The DSH host, other plugins, and the desktop client are out of scope for this repository.
