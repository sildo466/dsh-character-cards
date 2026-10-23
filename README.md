# dsh-character-cards

English | [简体中文](README.zh.md)

Switchable identity cards for [DeepSeek Harness](https://github.com/deepseek-ai) sessions: persona, tone, code style, and hard constraints injected as one session-scoped prompt section.

## Features

- Five structured groups: identity, voice, code style, workflow, and hard constraints.
- A global default card plus per-session overrides; a session can also explicitly take no card.
- A card picker beside the composer and a full editor in Settings.
- Live preview with token count and rule advisories.
- Explicit "re-apply" for sessions already running on a card; saving never rebinds anyone silently.
- Import, export, copy, and delete single `.dshcd` files. Unknown fields survive a round trip.

## Requirements

- DeepSeek Harness `>= 0.2.0-rc.2`
- Node `>= 22`

## Install

From npm:

```sh
dsh plugin --profile <profile> add dsh-character-cards
```

From GitHub:

```sh
dsh plugin --profile <profile> add github:sildo466/dsh-character-cards
```

On the desktop client, install `dsh-character-cards` (or `sildo466/dsh-character-cards`) from Settings -> Plugins. The desktop profile is app-managed, so install inside the app rather than through the CLI.

For local development:

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-character-cards
```

## Usage

1. Open Settings -> 角色卡.
2. Create a card, fill the identity and style fields, and save.
3. Pick the default card at the top of the page.
4. In a conversation, use the card picker beside the composer to pin one session, follow the default, or take no card.

Saving a card writes it to disk. A running session keeps the version it started with; press "重新应用" on the card row (or the same action in the editor) to push the new version into live sessions.

## Card format

A card is one `.dshcd` JSON file:

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

Fields this build does not know are preserved on save, so a card can carry forward-compatible data.

## Lifecycle

- Export downloads the exact stored JSON as `<id>.dshcd`.
- Import accepts one `.dshcd`/JSON object up to 1 MB, sanitizes the id, and auto-renames on conflict.
- Copy clones the whole card and names it `<name> 副本`.
- Delete removes the file, turns pins to an explicit "no card", clears the default pointer when it names the card, and unbinds live sessions.

## Development

```sh
node --test
```

No build step: the package ships its Node host half in `src/index.js` and its browser bundle in `src/client.js`.

## License

MIT
