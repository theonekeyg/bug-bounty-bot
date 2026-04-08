# Setup

## Prerequisites

### 1. Claude Code authentication

```bash
# Install Claude Code if not already installed
npm install -g @anthropic-ai/claude-code

# Authenticate with your subscription
claude auth login
```

The agent uses your Claude subscription — no API key needed.

### 2. Boxer sandbox

Boxer requires gVisor (`runsc`) and Docker.

```bash
# Install gVisor
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc

# Run Boxer
docker run -d \
  --name boxer \
  --privileged \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/theonekeyg/boxer:latest

# Verify
curl http://localhost:8080/swagger
```

### 3. Bun

```bash
# Install Bun if not already installed
curl -fsSL https://bun.sh/install | bash

# Install project dependencies
bun install
```

## Running

### Electron UI (recommended)

```bash
bun ui
```

### Headless

```bash
bun start --brief briefs/example.md
```

### With a custom Boxer URL

```bash
bun start --brief briefs/example.md --boxer http://192.168.1.50:8080
```

## Output

- `state/` — live research state (auto-created, gitignored)
- `output/report.md` — final vulnerability report
- `output/repro/<vuln-id>/` — reproduction scripts per finding
