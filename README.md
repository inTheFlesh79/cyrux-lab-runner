# CyruxLabs Lab Runner

A small Node.js / Express service that starts, restarts and stops pentesting labs as Docker Compose stacks. It runs on a Linux VM, separate from the main CyruxLabs backend, and is called by that backend whenever a student starts or ends a training session.

> **Status: prototype.** The runner has no authentication yet. Do not expose it to the internet. See [Security notes](#security-notes).

## What it does

- Receives a lab zip (an instructor-created bundle) and caches it per lab.
- Unzips it into a folder for each session and runs it with Docker Compose.
- Gives every session its own Compose project name (`-p <sessionid>`), so many students can run labs at the same time without colliding.
- Merges a shared base configuration (reverse proxy and network) with the lab's own `compose.yaml`.
- Detects the host port that Docker assigned to the lab's access proxy and reports it back, so the frontend can load the lab in an iframe.
- On stop or restart, collects evidence from the session (bash history and process command lines) so the backend can award trophies.

## How a session works

1. The backend calls `POST /start` with the lab zip and the session id.
2. The runner caches the zip at `labs-cache/{labid}/bundle.zip` and unzips it into `sessions/{sessionid}`.
3. It finds the lab's `compose.yaml` (searching up to 3 levels deep).
4. It runs `docker compose` with two files: `base/base-proxy.yaml` and the lab's `compose.yaml`, under project name `{sessionid}`.
5. It reads the host port that the `labaccessproxy` service publishes for container port 443.
6. It responds with that port and the protocol (`https`). The frontend builds the iframe URL from the VM's address and this port.
7. On `/stop` (or `/restart`) it collects the evidence, tears the stack down and returns the evidence to the backend.

## Base configuration

The `base/` folder holds what every lab shares:

- `base-proxy.yaml` defines the `labaccessproxy` service (nginx, publishes port 443, mounts the TLS certificates and `default.conf`) and two networks:
  - `publicnet`: a normal bridge network, used by the proxy.
  - `labnet`: an `internal: true` network. Lab services must join it, so they have no direct access to the outside world.
- Lab compose files must **not** publish host ports. The runner lets Docker assign them dynamically.

## Requirements

- Linux host (developed on Linux Mint in a VM)
- Node.js 18 or newer and npm
- Docker Engine with the Docker Compose v2 plugin (`docker compose`)
- The user running the runner must be able to use Docker without `sudo` (member of the `docker` group)
- TLS certificate and key for the access proxy (see [Certificates](#certificates))

## Installation

```bash
git clone <your-repo-url>
cd <repo-folder>
npm install
```

## Configuration

The runner listens on port **4000** by default. If your version reads settings from a `.env` file, create one next to the code. **Never commit it.**

```
PORT=4000
```

Adjust the variable names above to match your implementation.

### Certificates

`base-proxy.yaml` mounts a certificate and key into the nginx proxy. Create them on the VM (for example with `openssl`) and place them where `base-proxy.yaml` expects them. The certificate must match the address you use to reach the VM, otherwise browsers will warn or block the iframe. Private keys are listed in `.gitignore` and must never be pushed to the repository.

## Running

```bash
node server.js
```

Adjust the entry file or add an `npm start` script if your repo uses a different layout.

## API

| Method | Path       | Purpose                                                              |
|--------|------------|----------------------------------------------------------------------|
| POST   | `/start`   | Upload the lab zip, start the session stack, return the host port    |
| POST   | `/restart` | Recreate the session stack and return the evidence collected so far  |
| POST   | `/stop`    | Stop the session, remove the stack and return the collected evidence |

`/start` accepts a multipart upload (the zip is kept in memory by multer, then written to the cache).

Typical responses:

- `/start`: the assigned host `port` and `protocol` (`https`).
- `/stop` and `/restart`: the session evidence described below.

Check the code for the exact field names.

## Evidence collection

While a session runs, the runner gathers two kinds of evidence from the lab's `webtop` container:

- **Bash history**: read from `/config/.bash_history` when the session stops or restarts.
- **Processes**: command lines sampled with `docker top` every 10 seconds. A process that runs for less than the sampling interval can be missed.

The backend stores this evidence and uses it to decide command and process trophies.

## Runtime folders

These are created while the runner works and are not part of the source:

- `labs-cache/{labid}/bundle.zip`: cached lab zips
- `sessions/{sessionid}/`: unzipped lab for each running session

## Security notes

This is a prototype. Known gaps that are postponed until the project leaves the prototype stage:

- No authentication on `/start`, `/stop` and `/restart`.
- The session id is used to build shell commands and file paths, so it needs strict validation (shell injection and path traversal).
- Membership of the `docker` group is effectively root on the machine.

Until these are fixed:

- Run the runner only on a private network.
- Restrict access with a firewall so that only the CyruxLabs backend can reach it.
- Only run lab zips that passed the backend's validation and an admin's review.

## Related projects

- **CyruxLabs frontend**: React (Vite) app where users browse and run labs.
- **cyruxlabs-backend**: Node/Express API that manages users, labs and sessions and calls this runner.
