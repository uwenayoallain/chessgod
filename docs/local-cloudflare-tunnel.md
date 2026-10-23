# Local Cloudflare Tunnel Hosting

This runs ChessGod on this computer and exposes it at `https://chess.uwe.rw` through Cloudflare Tunnel. The site is available only while this computer, Docker, and `cloudflared` are running.

## 1. Cloudflare setup

1. Add `uwe.rw` to Cloudflare, or use the existing Cloudflare zone if it is already there.
2. In Cloudflare Zero Trust, create a tunnel for this machine.
3. Add a public hostname:
   - Hostname: `chess.uwe.rw`
   - Service: `http://frontend:5173`
4. Copy the tunnel token.

## 2. Local setup

Copy the tunnel env file and add the token:

```bash
cp .env.tunnel.example .env.tunnel
```

Edit `.env.tunnel` and set:

```bash
CLOUDFLARE_TUNNEL_TOKEN=...
```

Start everything:

```bash
make tunnel
```

Tail logs:

```bash
make tunnel-logs
```

Stop everything:

```bash
make tunnel-down
```

## Notes

- Public visitors must use `https://chess.uwe.rw`.
- The frontend uses same-origin `/api` in tunnel mode, so remote browsers do not try to call `localhost`.
- Do not expose host port `18000` directly to the internet. The tunnel should point only at the frontend service.
- Change `POSTGRES_PASSWORD` and `OBSERVABILITY_ADMIN_PASSPHRASE_SHA256` before using this with other people.
- If this PC sleeps, shuts down, loses internet, or Docker stops, the site goes offline.
