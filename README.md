# Slate CLIProxyAPI Route

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
