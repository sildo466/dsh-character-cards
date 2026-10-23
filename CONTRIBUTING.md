# Contributing

Thanks for taking the time to help. This is a small, single-maintainer project, so the most useful contributions are focused bug reports, clear reproduction steps, well-written cards, and small, tested pull requests.

## Ways to contribute

- **Report a bug** — open an issue with the plugin version, DSH version, steps to reproduce, and what you expected.
- **Request a feature** — describe the problem first, then the proposed behavior. A concrete use case is worth more than a long specification.
- **Share a card** — a `.dshcd` file is a self-contained contribution. Attach it to a discussion or issue, or include it in a PR under `examples/`.
- **Improve the docs** — English and Chinese READMEs are kept in sync; fixes to either side are welcome.
- **Send code** — see the development and review notes below.

## Before opening a pull request

- Open an issue first for anything beyond a small fix. It avoids building something the project does not want.
- Keep one concern per pull request. Do not mix a bug fix with a refactor or a documentation rewrite.
- Match the existing style. The codebase favors small functions, English comments, and no unrelated cleanup.
- Add a test for every behavior change. The project uses `node:test` and has no build step.

## Development

```sh
git clone https://github.com/sildo466/dsh-character-cards.git
cd dsh-character-cards
node --test
```

To run the plugin against a local profile:

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-character-cards
```

Restart the host after linking. The browser half is a plain client bundle; there is no compilation step.

## Commit and review

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- No emoji in code, comments, documentation, or commit messages.
- Explain the why in the commit body when it is not obvious.
- The maintainer reviews pull requests when time allows. Small, well-tested changes land fastest.

## Card contributions

A card is data, not code. Submissions must:

- Use a valid id: lowercase letters, digits, and hyphens, at most 64 characters.
- Stay under 1 MB.
- Keep every field human-readable JSON. Do not embed scripts, encoded payloads, or executable content.
- Be your own work, or carry permission and attribution for the original author.
- Avoid content that targets real people or violates the project's Code of Conduct.

If a card is meant as an example, add it under `examples/<id>.dshcd` and mention it in the pull request. The maintainer may edit the copy for clarity.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the MIT License.
