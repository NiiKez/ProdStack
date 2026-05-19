# Local dev tunnel via `cloudflared`

GitHub webhooks need to reach the backend on a public URL during local
development. We use Cloudflare Quick Tunnels — they give you a free
`https://<random>.trycloudflare.com` URL pointed at `http://localhost:3000` with
zero account setup.

## 1. Install `cloudflared`

**Debian / Ubuntu / Parrot (apt repo):**

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update
sudo apt-get install -y cloudflared
```

**No-sudo binary (any Linux amd64):**

```bash
mkdir -p ~/.local/bin
curl -fsSL -o ~/.local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared
```

Verify: `cloudflared --version`.

For other platforms see <https://pkg.cloudflare.com/index.html> or the
[GitHub releases page](https://github.com/cloudflare/cloudflared/releases).

## 2. Start the backend

In one terminal:

```bash
docker compose up -d        # Postgres
npm run dev --workspace @prodstack/api
```

Confirm the health route locally:

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

## 3. Start the tunnel

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a banner with the public URL. Look for a line like:

```
Your quick Tunnel has been created! Visit it at:
https://conventional-mba-wake-supposed.trycloudflare.com
```

That subdomain is random and changes every time you restart the tunnel — for a
stable URL you'd need a named tunnel + Cloudflare account (defer to post-MVP).

## 4. Verify end-to-end

```bash
TUNNEL=https://<your-random>.trycloudflare.com
curl -i "$TUNNEL/healthz"
```

You should see `HTTP/2 200` with `{"status":"ok"}` and a `server: cloudflare`
response header — proof the request traversed Cloudflare's edge into your local
Express server.

### DNS-cache gotcha

If `curl` reports `Could not resolve host: *.trycloudflare.com` for ~30s after
starting the tunnel, your local resolver hasn't picked up the new subdomain yet.
Workarounds:

```bash
# Resolve via Cloudflare DNS explicitly:
curl --resolve "<host>:443:$(dig +short @1.1.1.1 <host> | head -1)" \
  "https://<host>/healthz"

# Or flush systemd-resolved:
sudo resolvectl flush-caches
```

It usually self-heals within a minute.

## 5. Wire the URL into the backend

When M2 lands, set `PUBLIC_API_URL` to the tunnel URL in `backend/.env` so
webhook registration points GitHub at the tunnel:

```env
PUBLIC_API_URL=https://conventional-mba-wake-supposed.trycloudflare.com
```

GitHub webhook deliveries to `${PUBLIC_API_URL}/api/webhooks/github` will then
land in your local Express handler.
