# Generic Kan deployment and offline Trello migration runbook

This runbook deploys Kan at a hostname selected by the operator in an Ubuntu
LXC guest on Proxmox and imports Trello data from exported JSON files. The
examples use `kan.example.com`; replace it with the real hostname in `.env`.
No Trello API key, token, or network API access is required.

```text
client -> LXC :80/:443 -> Nginx -> Kan web -> PostgreSQL
                                           ^
                                           |
                    read-only Trello export importer (run only on demand)
```

Only Nginx publishes host ports. Kan and PostgreSQL remain on private Docker
networks. The importer sees the export directory read-only and writes each board
inside a separate database transaction.

SMTP and S3-compatible object storage are deliberately left unconfigured.
Boards and offline imports work without them, but password-reset/invitation
email and new file uploads require those services. Optional variables remain in
the upstream `.env.example`.

## 1. Prerequisites

Confirm all of the following before the maintenance window:

- The hostname you will set as `KAN_HOSTNAME` resolves to the address receiving
  HTTPS traffic.
- TCP 80 and 443 can reach the LXC. Limit SSH to the administration network.
- You have the TLS certificate's full chain and unencrypted private key.
- The certificate covers the configured hostname and is not expired.
- You have extracted the Trello Workspace export ZIP, including its JSON files.
- Allocate at least 2 vCPU, 4 GiB RAM, and 20 GiB disk for the source build.

Use an unprivileged Ubuntu 24.04 LXC. On the Proxmox host, enable the nested
container features while the guest is stopped:

```bash
pct stop <VMID>
pct set <VMID> -features nesting=1,keyctl=1
pct start <VMID>
```

Do not expose Docker's daemon socket or TCP API to the network.

## 2. Install Docker in the Ubuntu LXC

Run these commands inside Ubuntu. They use Docker's official apt repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl rsync unzip
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
printf '%s\n' \
  'Types: deb' \
  'URIs: https://download.docker.com/linux/ubuntu' \
  "Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}" \
  'Components: stable' \
  "Architectures: $(dpkg --print-architecture)" \
  'Signed-By: /etc/apt/keyrings/docker.asc' \
  | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker containerd
sudo docker run --rm hello-world
```

Docker-published ports can bypass uncomplicated host firewall rules. This
Compose file publishes only 80 and 443; enforce further restrictions in the
Proxmox firewall or Docker's `DOCKER-USER` chain.

Reference: [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

## 3. Place the project

Copy the complete `kan-offline-trello` directory to the LXC. The rest of this
runbook assumes a root shell:

```bash
sudo -i
mkdir -p /srv/kan-offline-trello
rsync -a ./kan-offline-trello/ /srv/kan-offline-trello/
chown -R root:root /srv/kan-offline-trello
cd /srv/kan-offline-trello
```

Membership in the `docker` group is effectively root-level control of the LXC;
assign it only if required.

## 4. Install the TLS certificate

Replace these two placeholder files with the real material:

```text
deploy/tls/tls.crt   full certificate chain, leaf first
deploy/tls/tls.key   matching unencrypted private key
```

Then restrict access:

```bash
chown root:root deploy/tls/tls.crt deploy/tls/tls.key
chmod 0644 deploy/tls/tls.crt
chmod 0600 deploy/tls/tls.key
```

The preflight check rejects placeholders, encrypted keys, expired certificates,
and certificate/key mismatches. After renewing the certificate:

```bash
docker compose exec proxy nginx -t
docker compose exec proxy nginx -s reload
```

## 5. Configure secrets

Create the runtime environment file:

```bash
cd /srv/kan-offline-trello
cp .env.kan.example .env
openssl rand -hex 32
openssl rand -hex 32
sudoedit .env
```

Use a different generated value for `POSTGRES_PASSWORD` and
`BETTER_AUTH_SECRET`. Keep both stable. Changing `BETTER_AUTH_SECRET`
invalidates sessions and other encrypted application data.

Replace `KAN_HOSTNAME=kan.example.com` with the public DNS hostname, without
`https://` or a trailing slash. `COMPOSE_PROJECT_NAME` controls the prefix for
containers, networks, and locally built images; change it when running multiple
instances on one Docker host.

No Trello credentials are required. `TRELLO_EXPORT_DIR` defaults to
`./imports/trello-export`. Docker mounts that exact directory read-only at
`/trello-export` inside the one-shot importer container.

Keep `NEXT_PUBLIC_DISABLE_SIGN_UP=false` only long enough to create the first
account. Protect the environment file and create the persistent directories:

```bash
chmod 0600 .env
mkdir -p data/postgres backups imports
```

## 6. Validate and start Kan

```bash
chmod +x deploy/preflight.sh
./deploy/preflight.sh
docker compose build --pull web migrate
docker compose up -d
docker compose ps -a
docker compose logs migrate
```

Expected state:

- The `postgres`, `web`, and `proxy` services are running.
- The `migrate` service exited with code 0; it is a one-shot migration job.
- The configured HTTPS hostname redirects to Kan's login page without a
  certificate warning.

Verify from an administrator workstation:

```bash
site_host="$(sed -n 's/^KAN_HOSTNAME=//p' .env | tail -n 1)"
curl -I "http://${site_host}"
curl -I "https://${site_host}/login"
openssl s_client -connect "${site_host}:443" \
  -servername "$site_host" </dev/null
```

## 7. Create the first account and close registration

While access is limited to the administration network:

1. Open the HTTPS hostname configured as `KAN_HOSTNAME`.
2. Register the first operations account.
3. Create the Kan workspace that will receive the imported boards. Record its
   URL slug—for example, `operations` from `/operations/boards`.
4. Edit `.env` and set `NEXT_PUBLIC_DISABLE_SIGN_UP=true`.
5. Recreate the web container:

```bash
docker compose up -d --force-recreate web
```

Email is disabled in this template, so password-reset email will not work until
SMTP is configured. Store the initial credentials in the approved password
manager.

The upstream Kan interface may still display **Connect Trello** or an online
Trello import source. Do not use those controls in this deployment; they require
Trello API access. Use the one-shot offline importer below.

## 8. Prepare the Trello export

Trello Workspace exports contain JSON and CSV representations. Use JSON for the
migration because it retains nested relationships such as labels, checklists,
comments, members, and attachments. CSV files are left untouched and reported
by the scanner but are not imported.

If the download is a ZIP, extract it without rearranging its directories:

```bash
mkdir -p /srv/kan-offline-trello/imports/trello-export
unzip /path/to/trello-workspace-export.zip \
  -d /srv/kan-offline-trello/imports/trello-export
find /srv/kan-offline-trello/imports/trello-export -type f \
  \( -iname '*.json' -o -iname '*.csv' \) | sort | less
```

The importer scans all subdirectories and recognizes JSON objects containing a
Trello board with `lists` and `cards`. It deduplicates repeated copies by Trello
board ID. It does not require a particular export directory name.

The two paths below refer to the same files on opposite sides of the Docker
mount:

| Context | Trello export path |
| --- | --- |
| Ubuntu LXC host | `/srv/kan-offline-trello/imports/trello-export` |
| Importer container | `/trello-export` |

Set `TRELLO_EXPORT_DIR` in `.env` only if the host directory is different. Do
not pass the host path to `--source`; that option is evaluated inside the
container.

Keep the original ZIP immutable as the migration source of record. Atlassian
documents that Workspace exports contain JSON and CSV for boards and can include
raw attachments: [Export data from Trello](https://support.atlassian.com/trello/docs/exporting-data-from-trello/).

## 9. Scan and dry-run the import

Build the migration and importer images, then explicitly bring the database
schema up to date:

```bash
cd /srv/kan-offline-trello
docker compose --profile tools build migrate trello-import
docker compose run --rm migrate
```

The importer image definition is embedded in `docker-compose.yml`; it does not
depend on another Dockerfile or a named build stage in `apps/web/Dockerfile`.

Scan the export without connecting to PostgreSQL:

```bash
docker compose run --rm --no-deps trello-import \
  --source /trello-export \
  --scan-only
```

The output lists every recognized board and its list, card, checklist, comment,
and attachment-reference counts. Resolve malformed JSON warnings before
continuing. A JSON file that is not a Trello board is safely ignored.

Back up Kan before the dry run and again immediately before the live import:

```bash
docker compose exec -T postgres \
  pg_dump -U kan -d kan_db -Fc \
  > "backups/kan-offline-pre-import-$(date +%F-%H%M).dump"
```

Validate the destination account and workspace without writing anything:

```bash
docker compose run --rm trello-import \
  --source /trello-export \
  --user-email admin@example.com \
  --workspace operations \
  --dry-run
```

The email must belong to an active Kan member or administrator of the target
workspace. Guests cannot own imported boards. `--workspace` accepts the exact
workspace slug, public ID, or name; the slug is least ambiguous.

The destination address is the account in the new Kan installation. It does
not have to match addresses stored in the Trello export. Replace
`admin@example.com` in these examples with the actual account address.

To pilot one or more boards, add a case-insensitive name filter. The option may
be repeated:

```bash
docker compose run --rm trello-import \
  --source /trello-export \
  --user-email admin@example.com \
  --workspace operations \
  --board 'Facilities' \
  --dry-run
```

## 10. Run the offline import

Import the pilot board by removing `--dry-run`:

```bash
docker compose run --rm trello-import \
  --source /trello-export \
  --user-email admin@example.com \
  --workspace operations \
  --board 'Facilities'
```

After validating the pilot in Kan, import all remaining boards:

```bash
docker compose run --rm trello-import \
  --source /trello-export \
  --user-email admin@example.com \
  --workspace operations
```

By default, closed lists and archived cards are skipped. To preserve them as
normal Kan items with an `[Archived]` name prefix, use `--include-archived` in
the scan, dry run, and live run.

Each Trello board gets a deterministic slug such as `trello-abcd1234` and a
source-ID marker. A rerun skips boards whose slug already exists. Do not use
`--allow-duplicates` unless a second copy is intentional.

Each board is atomic: an error rolls back that entire board while boards already
completed by earlier commands remain intact.

## 11. Data mapping and limitations

| Trello export data | Offline import result |
| --- | --- |
| Board name and description | Kan board name and description |
| Lists and cards | Kan lists and cards, ordered by Trello `pos` |
| Card descriptions | Kan card descriptions |
| Due dates | Kan due dates |
| Labels, including unnamed labels | Kan labels and card relationships |
| Checklists and item completion | Kan checklists and completed state |
| Comments present in `actions` | Kan comments with original author/date prepended |
| Card members | Preserved as readable metadata in the card description |
| Custom fields | Preserved as readable metadata in the card description |
| Attachment names and URLs | Preserved as links in the card description |
| Raw attachment files in export folders | Retained in the export; not uploaded to Kan/S3 |
| Archived items | Skipped unless `--include-archived` is supplied |
| Trello users and permissions | Not converted to Kan accounts or permissions |
| Butler/automation rules, Power-Ups, board styling | Not imported |

All imported records are attributed in Kan to the destination account. For
comments, the original Trello author and date are embedded in the comment text.
Trello's board JSON may include only a limited action history; the importer can
only migrate comments present in the supplied export.

Attachment URLs can later expire or require Trello authentication. Preserve the
raw export and treat uploading attachment files into configured object storage
as a separate migration phase.

## 12. Validate and close out the migration

For each pilot and batch, compare:

- board names and list/card counts;
- list and card order;
- several long descriptions and special characters;
- labels and colours;
- due dates;
- checklist order and completion state;
- comment author/date prefixes;
- member, custom-field, and attachment metadata.

Keep Trello available read-only until the business owner signs off. Record
board-by-board acceptance, exceptions, and the final cutover time. Store the
original export and PostgreSQL backup under your organization's retention and
access-control policy.

## 13. Backup and rollback

Create a backup at any time:

```bash
docker compose exec -T postgres \
  pg_dump -U kan -d kan_db -Fc \
  > "backups/kan-offline-$(date +%F-%H%M).dump"
```

Copy backups outside the LXC or include `/srv/kan-offline-trello/data` and
`/srv/kan-offline-trello/backups` in Proxmox backups. Test restoration on a
separate non-production instance.

For one bad board, delete only that imported board in Kan and rerun it after
correcting the export or options. A full PostgreSQL restoration replaces every
change made after the dump and therefore requires an approved maintenance
window.

## 14. Troubleshooting

| Symptom | Check |
| --- | --- |
| Scanner finds zero boards | Confirm the ZIP was extracted and the JSON files contain top-level or nested objects with `lists` and `cards`. |
| Permission denied reading exports | Confirm `TRELLO_EXPORT_DIR` exists and is readable; it is mounted read-only at `/trello-export`. |
| `target stage "trello-importer" could not be found` | The server has an older `docker-compose.yml`. Replace it with the current file, then rebuild the importer. |
| `Dockerfile.trello-importer: no such file or directory` | The server has the intermediate Compose configuration that expected a separate Dockerfile. Replace `docker-compose.yml` with the current self-contained version, then rebuild. |
| `relation "user" does not exist` or `Kan schema is incomplete` | Rebuild the `migrate` image and run `docker compose run --rm migrate`. Confirm the importer and web service use the same `POSTGRES_URL`, then retry. |
| CSV files are reported but ignored | Expected; use the corresponding JSON because CSV loses nested relationships. |
| Destination membership not found | Verify the exact Kan email and workspace slug, and ensure the account is an active member/admin. |
| Board is skipped | Its deterministic `trello-...` slug already exists. Inspect the existing board before considering `--allow-duplicates`. |
| One board fails | That board was rolled back. Correct the reported data/schema issue and rerun with `--board`. |
| Nginx will not start | Replace the TLS placeholders and run `./deploy/preflight.sh` plus `docker compose logs proxy`. |
| Sign-in fails after restart | Confirm `BETTER_AUTH_SECRET` did not change and system time/DNS are correct. |

To inspect importer help:

```bash
docker compose run --rm trello-import --help
```
