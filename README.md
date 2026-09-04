# Subagents for BB

Inspect the subagents that belong to the current chat without mixing in agents from
other projects or conversations.

## Features

- Active native delegations from the current chat, plus child and nested BB threads.
- Live active/idle/error/needs-input status.
- Provider, model, and reasoning level beside every agent.
- Hidden worker threads included.
- Auto-refresh while the chat is open.
- Read-only transcript for provider-native subagents.
- Full embedded BB chat and one-click split view for child BB threads.
- Active-agent badge in the thread header.

## Install

From the y5k marketplace:

```bash
bb marketplace add git:https://github.com/imyeskela/y5k-bb-marketplace.git@main
bb plugin install subagents@y5k --yes
```

For local development:

```bash
npm install --include=dev
npm run check
bb plugin install . --yes
```

Open an existing thread and click the **Subagents** button in its header, or
choose **Subagents** from the right panel's new-tab actions.

## Compatibility

Requires BB 0.41 or newer and Plugin SDK 0.4.34 or newer.

## License

MIT
