# OpenSlate — CLIProxyAPI Route

Local MITM proxy that rewrites Slate API traffic through CLIProxyAPI-compatible endpoints. Routes `v3/stream` requests through a local HTTPS proxy to translate payloads between Slate's native format and CLIProxyAPI providers.

## What's Included

| File | Purpose |
|------|---------|
| `install.mjs` | Installer — copies scripts to `~/.local/bin/` with backups |
| `files/slate` | Shell wrapper — auto-starts proxy and exec's the real Slate CLI |
| `files/slate-cliproxyapi` | Shell wrapper — same as `slate` but used by the proxy for direct CLIProxyAPI config |
| `files/slate-randomlabs-proxy.js` | MITM proxy server — intercepts and rewrites HTTPS traffic |

## Install

```bash
node install.mjs
```

This copies all files to `~/.local/bin/`, backing up any existing versions to `~/.local/share/slate-cliproxyapi-route/backups/<timestamp>/`.

## Requirements

- [Slate CLI](https://github.com/istresearch/slate) installed at `/home/ubuntu/.nvm/versions/node/v24.13.0/bin/slate`
- Node.js (for the proxy server)
- `http-mitm-proxy` npm package (for the proxy)
- Slate config at `~/.config/slate/slate.json` with a `cliproxyapi` provider entry

## How It Works

1. The `slate` wrapper checks if your Slate config references a `cliproxyapi` provider
2. If so, it starts `slate-randomlabs-proxy.js` on `127.0.0.1:8899` (configurable via `SLATE_RANDOMLABS_PROXY_PORT`)
3. Sets `HTTPS_PROXY`/`HTTP_PROXY`/`SSL_CERT_FILE` to route Slate traffic through the local proxy
4. The proxy intercepts requests, rewrites `v3/stream` payloads between Slate format and CLIProxyAPI format
5. Traffic logs go to `~/.local/share/slate-randomlabs-proxy/traffic.jsonl`

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SLATE_RANDOMLABS_PROXY_PORT` | `8899` | Proxy listen port |
| `SLATE_RANDOMLABS_PROXY_HOST` | `127.0.0.1` | Proxy listen host |
| `SLATE_RANDOMLABS_PROXY_DIR` | `~/.local/share/slate-randomlabs-proxy` | State directory |
| `SLATE_RANDOMLABS_PROXY_LOCAL_PORT` | `8898` | Local HTTPS server port |
| `SLATE_RANDOMLABS_PROXY_MAX_BODY` | `8388608` | Max request body bytes |
| `SLATE_RANDOMLABS_PROXY_MAX_UPSTREAM_CHARS` | `450000` | Max upstream payload chars |
| `SLATE_API_KEY` | — | Slate API key (or read from `~/.config/slate/slate-api-key`) |
| `SLATE_CONFIG` | `~/.config/slate/slate.json` | Slate config path |

## Proxy Features

The `slate-randomlabs-proxy.js` proxy handles:

- **SSL/TLS interception** — auto-generates CA and per-host certificates
- **Request/response rewriting** — translates between API formats
- **Traffic logging** — JSONL dump of all proxied traffic
- **Request dump files** — optional full request/response dumps for debugging
- **Stream handling** — SSE/streaming response translation
- **Provider routing** — routes to different backends based on config

## License

Private — Microck
