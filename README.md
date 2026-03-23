# Slate CLIProxyAPI Route

> If anyone at Random Labs sees this and decides to patch it, that is the wrong move. In a world of harnesses, competition is high, and forcing users to spend only Slate credits is product suicide. It should be an option, not a requirement.

Keeps Slate routed through local `CLIProxyAPI` instead of Random Labs model credits.

## Install

```bash
node install.mjs
```

## Verify

Open `slate`, send `reply with exactly ok`, then check:

```bash
tail -n 40 ~/.local/share/slate-randomlabs-proxy/traffic.jsonl
```

You should see `rewrite` and `local-worker-request` entries for `/v3/stream`.
