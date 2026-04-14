# Elsa

**Telegram & Discord bridge for Claude Code — use Claude from your phone.**

Elsa lets you control [Claude Code](https://claude.ai/code) from your phone via Telegram or Discord. Just run a single daemon on your dev machine — no server or public URL needed. It connects to the platforms via long polling and spawns a local `claude` CLI process to handle your requests.

## Features

- **Telegram + Discord dual platform** — use either or both simultaneously
- **Single Bot, Multi-Repo** — one worker bot manages multiple project directories, switch with `/repo switch`
- **Streaming responses** — real-time streamed output with debounced message updates
- **File & image support** — send files/photos to Claude, it reads them directly
- **Session management** — start new sessions, resume CLI sessions, switch models
- **Scheduled tasks** — natural language scheduling (e.g., "daily 9am run tests")
- **Live preview** — ngrok tunnels for instant dev server previews from your phone
- **Multi-user access control** — `/allow` other users to share your bot
- **Auto health check** — automatic worker recovery every 5 minutes

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** — installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **Telegram Bot Token** (from [@BotFather](https://t.me/BotFather)) and/or **Discord Bot Token** (from [Discord Developer Portal](https://discord.com/developers/applications))

## Installation

### From npm

```bash
npm install -g elsa
elsa setup
elsa start
```

### From source

```bash
git clone https://github.com/nicepkg/elsa.git
cd elsa
npm install
```

### Windows quick start

```bat
setup.bat              REM Install dependencies + interactive setup
start.bat              REM Launch the daemon (foreground)
start-background.bat   REM Launch the daemon (background, minimized)
stop-background.bat    REM Stop the background daemon
```

### Linux one-liner

```bash
bash install_linux.sh   # Install + build + systemd service
elsa setup              # Configure bot tokens
elsa start              # Start daemon
```

## Setup

Run the interactive setup wizard:

```bash
# From source
npx tsx src/cli.ts setup

# If installed globally
elsa setup
```

The wizard will ask you to:

1. **Choose platform** — Telegram / Discord / Both
2. **Telegram** (if selected):
   - Manager Bot token (create one via [@BotFather](https://t.me/BotFather))
   - Your Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot))
3. **Discord** (if selected):
   - Bot token (from [Discord Developer Portal](https://discord.com/developers/applications))
   - Guild (server) ID
   - Your Discord user ID
4. **ngrok token** (optional, for `/preview` feature)

All config is stored in `~/.elsa/config.json` with restricted permissions.

## Usage

### Starting the daemon

```bash
# Direct run (development)
npm start

# Watch mode (auto-restart on file changes)
npm run dev

# Background daemon (macOS / Linux)
elsa start
elsa status
elsa logs
elsa stop
```

**Windows background mode:**

```bat
start-background.bat   REM Start daemon minimized to taskbar
stop-background.bat    REM Stop the background daemon
```

### First steps

1. Start the daemon
2. Open Telegram/Discord and message the **Manager Bot**
3. Use `/add` to create a worker bot (you'll need another bot token)
4. Message the **Worker Bot** — it's your Claude interface!
5. Send any message to start coding with Claude

### System service (auto-start on boot)

```bash
# macOS (launchd) / Linux (systemd)
elsa install-service

# Remove
elsa uninstall-service
```

## Commands

### CLI

| Command | Description |
|---------|-------------|
| `elsa setup` | Interactive bot configuration |
| `elsa start` | Start daemon in background |
| `elsa stop` | Stop the daemon |
| `elsa status` | Check if daemon is running |
| `elsa logs` | Tail daemon logs (Ctrl+C to exit) |
| `elsa install-service` | Install as system service |
| `elsa uninstall-service` | Remove system service |

### Manager Bot (Telegram & Discord)

| Command | Description |
|---------|-------------|
| `/add` | Add a new worker bot |
| `/remove <bot>` | Remove a worker bot (or `all`) |
| `/bots` | List active worker bots |
| `/schedules` | View all scheduled tasks |

### Worker Bot (Telegram & Discord)

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (clear context) |
| `/model` | Switch Claude model (Opus / Sonnet / Haiku) |
| `/cost` | Show token usage for current session |
| `/session` | Get session ID (to continue in CLI) |
| `/resume <id>` | Resume a CLI session in the bot |
| `/cancel` | Abort the current operation |
| `/help` | Show help |
| `/preview [port]` | Open ngrok tunnel for dev server preview |
| `/close` | Close preview tunnel |
| `/cron add <task>` | Add scheduled task (natural language, e.g., "daily 9am run tests") |
| `/cron list` | List all scheduled tasks |
| `/cron del <n>` | Remove a scheduled task |
| `/mode` | Switch permission mode (Bypass / Accept Edits / Plan) |
| `/repo add <path> [alias]` | Add a project directory |
| `/repo list` | List registered repos |
| `/repo switch <alias>` | Switch to a different repo |
| `/repo remove <alias>` | Remove a repo |
| `/allow <user>` | Grant another user access (owner only) |
| `/deny <user>` | Revoke user access (owner only) |
| `/members` | List authorized users (owner only) |

## Architecture

```
Daemon
├── Manager Bot (Telegram / Discord)
│   └── /add, /remove, /bots — manage worker bots
├── Worker Bot × N
│   └── BridgeRouter — routes chat → repo
│       └── ClaudeBridge × N — one Claude CLI per repo
├── Scheduler — cron-based task execution
└── Tunnel — ngrok tunnels for /preview
```

- **ClaudeBridge** spawns a local `claude` CLI in `stream-json` mode and parses output in real-time
- **BridgeRouter** manages multiple ClaudeBridge instances, one per registered repo
- **Scheduler** uses Claude Haiku to parse natural language into cron expressions

## Configuration

Settings are loaded in order: **environment variables** > **`~/.elsa/config.json`**

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram Manager Bot token |
| `TELEGRAM_OWNER_ID` | Your Telegram user ID |
| `DISCORD_BOT_TOKEN` | Discord Manager Bot token |
| `DISCORD_GUILD_ID` | Discord server ID |
| `DISCORD_OWNER_ID` | Your Discord user ID |
| `NGROK_AUTH_TOKEN` | ngrok token (optional, for `/preview`) |

Data files stored in `~/.elsa/`:

| File | Content |
|------|---------|
| `config.json` | Bot tokens, owner IDs |
| `bots.json` | Telegram worker bot configs |
| `discord-bots.json` | Discord worker bot configs |
| `repos.json` | Registered repos (path + alias) |
| `schedules.json` | Scheduled tasks |
| `state-{botId}.json` | Session state per bot |
| `app.log` | Daemon logs (5MB auto-rotate) |

## Development

```bash
npm install          # Install dependencies
npm run dev          # Watch mode (auto-restart)
npm run build        # Build TypeScript → dist/
npx tsc --noEmit     # Type check only
npm test             # Run all tests
```

## License

MIT
