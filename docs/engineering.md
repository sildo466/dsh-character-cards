# Engineering notes

Technical details for people who want to read, modify, or build on the plugin. User-facing documentation lives in [README.md](README.md).

## How it works

The plugin is a standard DSH bundle with two halves:

- **Host half** (`src/index.js`) reads the card library, resolves which card a session should carry, registers HTTP routes, and binds the rendered card into the agent's prompt.
- **Browser half** (`src/client.js`) registers two slots:
  - `settings.section` — the card library and editor.
  - `conversation.input.left` — the picker beside the composer.

Resolution order for one session:

1. A per-session override that names a card.
2. A per-session override that is explicitly `null` — take no card.
3. The global default pointer.
4. Nothing configured — take no card.

The rendered card is registered as the prompt section `dshcd:identity`, one order after the host's persona section. Saving a card writes it to disk. Running sessions keep the version they started with until `POST /cards/<id>/apply` re-binds them.

## Card format

A card is one `.dshcd` file: UTF-8 JSON, version `1`. The id is the filename and must match `^[a-z0-9][a-z0-9-]*$`, at most 64 characters.

```json
{
  "dshcd": 1,
  "id": "patient-teacher",
  "name": "Patient Teacher",
  "description": "Explains code step by step.",
  "identity": {
    "role": "Patient teacher",
    "expertise": ["TypeScript", "testing"],
    "background": "Ten years of production systems."
  },
  "voice": {
    "tone": "Calm and direct",
    "verbosity": "Concise",
    "traits": ["encouraging"],
    "avoid": ["emoji"]
  },
  "code": {
    "naming": "Descriptive",
    "comments": "Only for non-obvious decisions",
    "tests": "Test behavior, not mocks"
  },
  "workflow": {
    "ask_when_unclear": true,
    "verify_before_claim": true
  },
  "constraints": ["Lead with the conclusion"]
}
```

The five groups map to the editor tabs. Strings, booleans, and string arrays are accepted. Fields the current build does not know are preserved on save, so a card can carry forward-compatible data.

Import rules:

- One JSON object, at most 1 MB.
- `dshcd` other than `1` is accepted with a warning and restamped to `1`.
- The id is lowercased, invalid runs are folded to `-`, trimmed, and cut to 64 characters; collisions get `-2`, `-3`, and so on.

## Storage

`$DSH_HOME/character-cards/` (or `~/.dsh/character-cards/` when `DSH_HOME` is unset):

```
<id>.dshcd        one card
default           default card id, one line
sessions.json     session id -> card id, or null for "no card"
```

An absent entry in `sessions.json` means "follow the default". An explicit `null` means "take no card". The two are not interchangeable.

Deleting a card:

1. Snapshot the live sessions that currently resolve to it.
2. Delete the file (the commit point).
3. Turn every pin naming it into an explicit `null`.
4. Clear the default pointer if it names the card.
5. Rebind the affected live agents to the new resolution (no card).

Cleanup failures after the file is gone are reported as warnings; they are not rolled back.

## HTTP routes

All routes live under `/dsh-character-cards` and are loopback/host guarded.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | health check |
| GET | `/cards` | library + default pointer + per-card session counts |
| POST | `/cards` | create (409 on an existing id) |
| GET | `/cards/<id>` | one raw card |
| PUT | `/cards/<id>` | update (id must match the path) |
| DELETE | `/cards/<id>` | delete, detach pins, clear default, unbind live agents |
| POST | `/cards/preview` | validate a draft, estimate tokens, return warnings |
| POST | `/cards/<id>/apply` | re-bind live sessions using the card |
| GET | `/session/<id>` | effective card and how it was chosen |
| POST | `/session/<id>/card` | set an override (`cardId`, `null`, or empty to follow the default) |
| POST | `/default` | set the global default |
| GET | `/status` | diagnostics |

## Development

```sh
node --test
```

There is no build step. The published package contains the source halves directly.

For a local profile:

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-character-cards
```

The desktop client manages its own profile; use the app's plugin page there.

## Compatibility and trust

- DSH `>= 0.2.0-rc.2`, Node `>= 22`.
- Cards are data. The plugin does not load scripts, plugins, or `!!js` expressions from a card.
- Routes reject non-loopback requests and unexpected Host headers.
- The browser half degrades when the host is unreachable or when a UI primitive is missing; it does not take the client down.
