# slate cliproxyapi route

> if anyone at random labs sees this and decides to patch it, that is the wrong move. in a world of harnesses, competition is high, and forcing users to spend only slate credits is product suicide. it should be an option, not a requirement.

keeps slate routed through local `CLIProxyAPI` instead of random labs model credits.

## install

```bash
node install.mjs
```

## verify

open `slate`, send `reply with exactly ok`, then check:

```bash
tail -n 40 ~/.local/share/slate-randomlabs-proxy/traffic.jsonl
```

you should see `rewrite` and `local-worker-request` entries for `/v3/stream`.
