# Generic offline Trello deployment

This directory is a reusable, self-hosted Kan package with an offline Trello
JSON importer. Set the public hostname in `.env` before deployment.

Start with [OFFLINE-TRELLO-RUNBOOK.md](OFFLINE-TRELLO-RUNBOOK.md). It covers:

- Ubuntu LXC and Docker installation on Proxmox;
- TLS termination using supplied certificate placeholders;
- required secrets and offline Trello export preparation;
- first-account bootstrap and registration lockdown;
- a recursive JSON export importer with scan, dry-run, filtering, validation,
  backup, and rollback procedures.

Do not start the Compose stack until the `.env` values and both files under
`deploy/tls/` have been replaced. Run `./deploy/preflight.sh` before deployment.
