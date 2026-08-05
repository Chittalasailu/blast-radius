# Deploying the hosted demo

The app is a single container: Fastify serves both the API and the built
frontend, so there is no separate static host and no CORS surface.

Connection details come from environment variables. No `.env` file is baked
into the image — `.dockerignore` excludes it.

## Railway

Railway is the shortest path because `railway.json` already pins the builder,
the start command and a health check.

1. Push the repository to GitHub (public, as the assignment requires):

   ```bash
   gh repo create blast-radius --public --source . --push
   ```

2. Create a Railway account at https://railway.app and start a new project
   from that GitHub repository. Railway reads `railway.json` and builds the
   `Dockerfile`.

3. Set three variables under **Variables**:

   | Variable | Value |
   | --- | --- |
   | `COGNODB_URI` | `bolt+s://<instance-id>.databases.cognodb.cloud` |
   | `COGNODB_USER` | `cognodb` |
   | `COGNODB_PASSWORD` | the password shown once at instance creation |

   `HOST` and `PORT` are already set in the `Dockerfile` (`0.0.0.0`, `8080`).
   If the platform injects its own `PORT`, that value wins — the server reads
   `process.env.PORT` first.

4. Under **Settings → Networking**, click **Generate Domain**. That URL is the
   demo link.

The health check hits `/api/health`. That endpoint deliberately returns `200`
with `{"ok": false}` when the database is unreachable rather than failing, so
a database outage shows the in-app banner instead of taking the whole
deployment down and putting it in a restart loop.

## Anywhere else

Any host that can run a Dockerfile works — Fly.io, Render, Cloud Run:

```bash
docker build -t blast-radius .
docker run -p 8080:8080 \
  -e COGNODB_URI='bolt+s://<instance-id>.databases.cognodb.cloud' \
  -e COGNODB_USER=cognodb \
  -e COGNODB_PASSWORD='<password>' \
  blast-radius
```

Then open http://localhost:8080.

## Checking a deployment

```bash
curl -s https://<your-domain>/api/health
```

- `{"ok":true,...}` — connected, with the Bolt protocol version.
- `{"ok":false,"configured":true,...}` — variables are set but the instance is
  unreachable. Check the instance is still running; free tiers can be paused.
- `{"ok":false,"configured":false,...}` — `COGNODB_URI` or `COGNODB_PASSWORD`
  is missing from the platform's environment.

## Note on the free CognoDB tier

The demo reads from the same instance used in development. Keep it running
until the assignment has been reviewed, then delete the instance or rotate the
password — the same credentials ship inside the portable Windows build.
