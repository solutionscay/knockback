# Deploying the match server (runbook)

One VM (Hetzner) runs two containers with Docker Compose: the match server (Bun,
SQLite) and Caddy (HTTPS with automatic Let's Encrypt certificates, reverse proxy).
Files: `Dockerfile`, `docker-compose.yml`, `deploy/` (Caddyfile, .env.example,
deploy.sh, backup.sh, restore.sh). Issue #26.

```
internet ──443/80──> caddy ──http──> server:5176 (not published)
                       │                │
                 caddy-data vol     kb-data vol: /data/match-server.db (+WAL), /data/records/*.json
```

- The server is one stateful process: matches in memory, long polls, live SSE. Every
  change is also in SQLite, so a restart (upgrade, crash, reboot) resumes running
  matches with the same hashes. Agents just retry; Caddy holds requests for up to
  20 s while the server restarts, so most clients see no error at all.
- Images are built on the operator's machine and shipped over SSH (`docker save |
  docker load`). There is no registry and no build on the VM.
- The VM directory (default `/opt/knockback`) holds only `docker-compose.yml`,
  `deploy/`, `.env`, `.previous-tag` and `backups/`.

## What the operator provides

| Item | Example | Used for |
|---|---|---|
| VM hostname or IP | `vm1.example.net` / `203.0.113.10` | SSH and the DNS record |
| SSH user (key login, member of the `docker` group) | `deploy` | `KB_HOST=deploy@vm1.example.net` |
| Public (staging) domain with an A/AAAA record to the VM | `kb-staging.example.com` | `KB_DOMAIN`, the certificate |
| VM CPU architecture | x86 (CX/CPX/CCX) or Arm (CAX) | `KB_PLATFORM=linux/amd64` or `linux/arm64` |
| Off-VM backup target (optional) | `backup@nas:/backups/knockback/`, a Hetzner Storage Box | `KB_BACKUP_REMOTE` |
| Deploy directory, if not `/opt/knockback` | | `KB_DIR` |

## First setup

1. **VM** (once, as root). Install Docker Engine with the compose plugin
   (https://docs.docker.com/engine/install/debian/), plus `rsync` if backups go off the VM.
   Then:
   ```sh
   adduser --disabled-password deploy && usermod -aG docker deploy   # add your SSH key to ~deploy/.ssh/authorized_keys
   mkdir -p /opt/knockback && chown deploy: /opt/knockback
   ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw enable   # or the Hetzner Cloud firewall
   ```
   Docker publishes ports itself. Check that the Hetzner Cloud firewall (if used) also allows 80 and 443.
2. **DNS:** an A (and AAAA) record from the domain to the VM. Caddy gets the
   certificate on its first start, so the record must resolve by then and port 80 must be reachable.
3. **First deploy** (from a clean checkout of the branch to deploy):
   ```sh
   KB_HOST=deploy@vm1.example.net KB_PLATFORM=linux/amd64 deploy/deploy.sh
   ```
   The first run uploads the files, creates `/opt/knockback/.env` from the template,
   and stops with exit code 2. On the VM, edit `.env`: set `KB_DOMAIN`, keep the ports
   80/443, and set `KB_BACKUP_REMOTE` if there is one. Then run the
   same command again. It builds, ships the image (about 275 MB unpacked), starts
   both containers, and waits for the healthcheck.
4. **Check** from anywhere:
   ```sh
   curl https://kb-staging.example.com/api/health          # {"ok":true,"version":"<git hash>",...}
   # joining needs an owner key: get one (or use the JOIN panel at /lobby#join)
   export KB_KEY=$(curl -s -X POST -H 'content-type: application/json' -d '{"owner":"staging-check"}' https://kb-staging.example.com/api/keys | jq -r .key)
   bun scripts/remote-agent.ts --server https://kb-staging.example.com --mode random --rounds 3
   ```
   Watch it in a browser at `https://kb-staging.example.com/watch`: the Arena runs house bots in every seat, and the
   agent takes one from the round after it joins.
5. **Nightly backups:** add a crontab entry for the deploy user:
   ```
   17 3 * * * cd /opt/knockback && deploy/backup.sh >> backups/backup.log 2>&1
   ```

## Upgrade

```sh
git pull   # or check out the commit to deploy; the tree must be clean (KB_ALLOW_DIRTY=1 overrides)
KB_HOST=deploy@vm1.example.net KB_PLATFORM=linux/amd64 deploy/deploy.sh
```
The script builds `knockback-server:<git hash>` and ships it. On the VM it takes a backup,
records the running tag in `.previous-tag`, writes the new tag into `.env`, runs
`docker compose up -d`, and waits until the server is healthy. Running matches resume
in the new version. Their rounds replay from SQLite, so this is only safe when the
new version doesn't change the simulation (sim hashes for seeds 1-200 unchanged, as
the checks require). For a change to the simulation, deploy when no match is
running (`GET /api/health` → `matches.running: 0`).

## Rollback

```sh
KB_HOST=deploy@vm1.example.net deploy/deploy.sh --rollback
```
This switches `.env` back to the tag in `.previous-tag` (its image is still on the VM),
recreates the server and waits for it to be healthy. Running it again goes forward
again. The database is not touched; to also go back in data, restore a backup (below).

## Backups

`deploy/backup.sh` (run in `/opt/knockback`) does four things:
1. Makes an online `sqlite3 .backup` inside the container. This is safe while matches run. The copy is turned into one self-contained file and integrity-checked.
2. Archives `records/` as `records-<stamp>.tar.gz`.
3. Deletes local copies older than `KB_BACKUP_KEEP_DAYS` (14).
4. Rsyncs them to `KB_BACKUP_REMOTE`, if set.

The files go to `backups/match-server-<stamp>.db` and `backups/records-<stamp>.tar.gz`.
Test a backup now and then: `sqlite3 backups/match-server-<stamp>.db 'PRAGMA integrity_check; SELECT count(*) FROM matches;'`.

## Restore

```sh
cd /opt/knockback
deploy/restore.sh backups/match-server-<stamp>.db backups/records-<stamp>.tar.gz
```
The script:
1. Takes a safety backup of the current state.
2. Stops the server and replaces the database (dropping its WAL).
3. Adds the records from the archive. Records already there are kept; they never change.
4. Checks the database and starts the server. Matches that were running in the backup resume.

From an off-VM copy, first copy the two files into `backups/`. To move to a new VM,
do a first setup there, then restore.

## Day to day

| Task | Command (in `/opt/knockback`) |
|---|---|
| status | `docker compose ps` (the server shows `healthy`); `curl https://$KB_DOMAIN/api/health` |
| logs | `docker compose logs -f server` / `caddy` (json-file, rotated at 10 MB × 5 per container) |
| restart | `docker compose restart server` (the Arena round in progress resumes; agents join again) |
| stop / start | `docker compose stop` / `docker compose up -d` (data stays on the volumes) |
| Arena, rounds, records | `curl https://$KB_DOMAIN/api/queue` (seats, queue, the round on now), `/api/matches`, `/api/records` |
| disk | `docker system df`; old images: `docker image prune` (keep the previous tag for rollback) |

- **Volumes:** `knockback_kb-data` holds the database and records. `knockback_caddy-data`
  holds the certificates; keep it, or Let's Encrypt rate limits can block new certificates.
  `docker compose down -v` deletes the volumes. Don't run it unless you mean to.
- **Settings** live in `.env`: `KB_DEADLINE` (seconds per agent turn), `KB_PUBLIC_URL`, `KB_FAST`, `KB_CHECKINS`.
  After an edit, run `docker compose up -d`.

## Operator data on the dev Mac (`KB_DATA`)

Durable Knockback files on the operator's Mac live in one root, `KB_DATA` (default `~/knockback-data`), on the
internal disk. It is not in git, not under `~/Documents` (OrbStack needs Full Disk Access to bind-mount from there)
and not on an external volume (it can be unmounted).

| Folder | Holds |
|---|---|
| `$KB_DATA/archive/` | the records archive (`records/`), its `index.csv` (paths relative to `archive/`) and the LAN database snapshots taken before each deploy (`lan-db-<date>-predeploy-<hash>/`) |
| `$KB_DATA/arena/` | the arena recording tools (`rec/`: run, record, serve, shot scripts) and their recordings |
| `$KB_DATA/secrets/` | owner keys for the operator's own agents (mode 700, files 600). Never commit or print them |

Agents must never write durable files under `~/skiff-agent`: its results folders are scratch, and they are deleted
when a task closes. That is how an owner key and thousands of archived records were lost (#155). Put anything that
must outlive the task in `$KB_DATA`.

## Troubleshooting

- **Certificate not issued:** `docker compose logs caddy`. The DNS record must point to the VM, and ports 80 and 443 must be open in both firewalls.
- **502 for more than 20 s:** the server isn't healthy. `docker compose ps`, then `docker compose logs --tail 100 server`.
- **A resumed round failed** (`GET /api/matches/<id>` shows `error`): the stored decisions don't replay with this version, because the simulation changed. The Arena goes on with the next round; to keep that round, roll back, let it finish, then upgrade.
- **Clients get 429:** the per-address limits. Behind Caddy the server takes the client address from `X-Forwarded-For`, and only from Caddy (private addresses).

## Rehearsal on a Mac (OrbStack)

```sh
docker compose --env-file my.env up -d --build      # my.env: KB_DOMAIN=localhost, KB_HTTP_PORT=8080, KB_HTTPS_PORT=8443
export KB_KEY=$(curl -sk -X POST -H 'content-type: application/json' -d '{"owner":"rehearsal"}' https://localhost:8443/api/keys | jq -r .key)
bun scripts/remote-agent.ts --server https://localhost:8443 --insecure --mode fixed --rounds 3
KB_HOST=local KB_DIR=/tmp/kb-stage KB_PLATFORM=linux/arm64 deploy/deploy.sh   # the whole deploy flow against the local Docker
```
