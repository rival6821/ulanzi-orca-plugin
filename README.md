# ulanzi-orca-plugin

**English** | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

An Ulanzi Studio plugin that shows your [Orca](https://orca.dev) agent sessions and remaining Claude / Codex usage limits on the Ulanzi D200H (macOS).

![Key preview](docs/preview.png)

- **Session slot**: Place it on several keys and Orca sessions fill them in key order. New sessions take the next empty slot; closed ones drop out and the rest shift forward. Press to switch Orca to that session; long-press to open a detail view with approve / stop / quick-reply buttons.
- **More sessions**: Pages through sessions when there are more sessions than slots.
- **Remaining limit**: Claude 5-hour / weekly and Codex 5-hour / weekly usage, plus time until reset. Press to toggle between used % and left %.
- **Claude buddy**: An animated Clawd that reacts to the overall state. Press to jump to the most urgent session.

Key design follows the D200H renderer from [AgentDeck](https://puritysb.github.io/AgentDeck/) (MIT, [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

## Installation

1. In Orca, register the `orca` CLI via **Settings → Experimental → CLI**.
2. Clone this repo and run `npm run install:local` (or unzip a release from Releases into `~/Library/Application Support/Ulanzi/UlanziDeck/Plugins/`).
3. Restart Ulanzi Studio and drag actions from the **Orca** category onto keys.
   - Top two rows: 9 session slots + More sessions in the last key of the second row
   - Left 3 keys of the bottom row: 3 remaining-limit keys (Claude 5H, Claude 7D, Codex 5H+7D are assigned automatically)

For how to read the keys, settings, and troubleshooting, see the [plugin README](com.ulanzi.orcasessions.ulanziPlugin/README.md) (Korean).

## Development

Requires Node.js 20 or later.

```bash
npm run setup          # install plugin runtime deps (ws, resvg-wasm and gifenc for GIFs)
npm test               # scenario tests against a fake Orca and a fake Ulanzi Studio
npm run preview        # after tests, writes test/out/preview.html — open it to check key rendering
npm run install:local  # install into this Mac's Ulanzi Studio (restart Studio afterwards)
npm run package        # build a release zip in dist/
```

Tests never touch the real Orca, the keychain, or the network. To debug on a real device, launch Ulanzi Studio with `--log --nodeRemoteDebug` and inspect the main service from `chrome://inspect` in Chrome.

Architecture, design decisions, and gotchas are documented in [CLAUDE.md](CLAUDE.md) (Korean).

## Layout

```
com.ulanzi.orcasessions.ulanziPlugin/   the plugin itself (this folder is installed as-is)
  manifest.json                         defines the 4 actions
  plugin/app.js                         main service: polling, slot assignment, key input
  plugin/orca.js                        runs the orca CLI (fixes up macOS PATH)
  plugin/usage.js                       fetches Claude / Codex usage
  plugin/render.js                      key SVG renderer (AgentDeck design)
  plugin/buddy.js                       Claude buddy key
  plugin/gif.js                         builds animated key GIFs
  plugin/ulanzi/, libs/                 official Ulanzi SDK (Apache-2.0, unmodified)
  property-inspector/inspector.html     settings UI (shared by all four actions)
test/                                   scenario tests with fake orca and usage APIs
scripts/                                local install, packaging
```

## License

[MIT](LICENSE). `com.ulanzi.orcasessions.ulanziPlugin/plugin/ulanzi/` and `libs/` are the official Ulanzi SDK (Apache-2.0), and the key design is taken from AgentDeck (MIT) — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
