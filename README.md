<h1 align="center">🤖 DOOMBOTS ⛏️</h1>
<p align="center">
  <strong>Autonomous AI Minecraft Agent Platform • Multi-Version Cross-Play Engine</strong><br>
  Powered by Local & Cloud LLMs • Mineflayer • ViaVersion / Geyser Bridging
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#-server-connectivity--aternos">Server Setup</a> •
  <a href="#-ai-models--providers">AI Models</a> •
  <a href="#-performance-modes">Performance Modes</a> •
  <a href="#-cli-flags">CLI Reference</a>
</p>

---

## ⚡ Highlights

- **Local Out-of-the-Box**: Defaults to **`ollama/qwen2.5:0.5b`** — no API keys or credit cards required!
- **Interactive Startup Control**: When launched, prompts `Press 'e' for setup or press [Enter] to run (auto-run in 5s)...` with instant Cyberpunk terminal dashboard.
- **Universal Multi-Version Cross-Play**: Bridges Minecraft 1.21.11, 1.21.4, Paper, Spigot, Geyser, ViaVersion, and ViaBackwards. Includes LoginGuard protections against invalid movement kicks.
- **Server Auto-Resolution**: Connects directly to LAN, VPS, or remote hosts like Aternos with automatic DNS SRV record resolution.
- **Sub-Second Cloud Speed**: Built-in support for **GroqCloud** (~0.3s responses) and **Cerebras** (1000+ tok/s).
- **Ultra-Low Memory Ready**: Runs smoothly on 4GB Linux, ChromeOS Crostini containers, and Android Termux with optimized V8 heap limits and automatic chunk pruning.
- **Control Center Web Dashboard**: Live web interface hosted at `http://localhost:8080` (`controlcenter:localhost`).

---

## 🚀 Quick Start

### 1. Requirements

- **Node.js**: v18 or v20 LTS recommended (`node -v`).
- **Minecraft**: Java Edition (v1.18 to v1.21.11, or Bedrock servers using Geyser).
- **Ollama** (for local offline mode): [Download Ollama](https://ollama.com/) and run:
  ```bash
  ollama pull qwen2.5:0.5b
  ollama serve &
  ```

### 2. Installation

Clone the repository and install dependencies:
```bash
git clone https://github.com/fallendrake0-droid/Doombots.git
cd Doombots
npm install --omit=optional
```

### 3. Launch Doombots

Start the agent:
```bash
npm start
```

When started, Doombots immediately displays the Cyberpunk terminal dashboard:
```
  ██████╗   ██████╗   ██████╗  ███╗   ███╗██████╗   ██████╗ ████████╗███████╗
  ██╔══██╗ ██╔═══██╗ ██╔═══██╗ ████╗ ████║██╔══██╗ ██╔═══██╗╚══██╔══╝██╔════╝
  ██║  ██║ ██║   ██║ ██║   ██║ ██╔████╔██║██████╔╝ ██║   ██║   ██║   ███████╗
  ██║  ██║ ██║   ██║ ██║   ██║ ██║╚██╔╝██║██╔══██╗ ██║   ██║   ██║   ╚════██║
  ██████╔╝ ╚██████╔╝ ╚██████╔╝ ██║ ╚═╝ ██║██████╔╝ ╚██████╔╝   ██║   ███████║
  ╚═════╝   ╚═════╝   ╚═════╝  ╚═╝     ╚═╝╚═════╝   ╚═════╝    ╚═╝   ╚══════╝
  Autonomous AI Minecraft Agent Platform • Multi-Version Cross-Play Engine

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  🎮 CONTROL CENTER : controlcenter:localhost (http://localhost:8080)     │
  │  🌍 TARGET SERVER  : 127.0.0.1:55916 (Protocol: Java 1.21.4 • ViaVersion)│
  │  🤖 ACTIVE AGENT   : Doombot                                             │
  │  🧠 AI MODEL       : ollama/qwen2.5:0.5b                                 │
  │  🛡️ LOGIN GUARD    : Active (Minecraft 1.21.11 & Geyser / Aternos)       │
  │  ⚡ ENGINE MODE    : Fast Response (0ms delay) | Low-Memory (4GB RAM)    │
  └──────────────────────────────────────────────────────────────────────────┘

[Doombots] Press 'e' for setup or press [Enter] to run (auto-run in 5s)...
```

- **Press `[Enter]`** (or wait 5 seconds): Starts `Doombot` immediately using your current settings.
- **Press `e`**: Opens the interactive configuration wizard to change your model, server host/port, API keys, or bot name.
- **Skip prompt**: Run `npm start -- --now` (or `node main.js --now`).

---

## 🌍 Server Connectivity & Aternos

Doombots supports all Minecraft server environments out-of-the-box:

### Connecting to a Remote Server / Aternos

You can connect directly from the command line using `--host`:

```bash
# Connect to your Aternos server (supports host:port syntax)
npm start -- --host ZCClanOnTOP.aternos.me:38410

# Or with node directly
node main.js --host ZCClanOnTOP.aternos.me:38410
```

> **Aternos Tips**:
> 1. In your Aternos dashboard, make sure your server is online.
> 2. Click **Connect** on your dashboard to find your unique 5-digit port (e.g. `38410`).
> 3. In Aternos **Options**, turn **ON 'Cracked'** if you are connecting with offline authentication.
> 4. If a whitelist is enabled on your server, run `/whitelist add Doombot` in the server console.

### Connecting to Local / LAN Worlds

1. In Minecraft, open your single-player world.
2. Press **Esc** -> **Open to LAN** -> note the port (or set it to `55916`).
3. Run `npm start -- --port <port>`.

---

## 🧠 AI Models & Providers

Doombots supports **over 50 AI providers** with automatic multi-key rotation and low-latency streaming:

### 1. Offline Local Mode (Default: `ollama/qwen2.5:0.5b`)
- Runs 100% locally on your machine without an internet connection or API keys.
- Requires Ollama running in the background (`ollama serve`).

### 2. Ultra-Fast Cloud Mode (Recommended: GroqCloud ~0.3s)
For near-instant sub-second bot reactions on low-spec hardware (Chromebooks, laptops):
1. Get a free API key at [console.groq.com](https://console.groq.com).
2. Run `npm start`, press **`e`**, select **GroqCloud**, and paste your key.
3. The bot will think and reply at **500+ tokens/sec**!

### Supported Providers

| Provider | Model Flag / ID | Key Env Variable | Speed / Feature |
| :--- | :--- | :--- | :--- |
| **Ollama (Local)** | `ollama/qwen2.5:0.5b` | *None needed* | 100% offline, default, privacy-first |
| **GroqCloud** | `groq/llama-3.3-70b-versatile` | `GROQCLOUD_API_KEY` | Ultra-fast (~0.3s responses, free tier) |
| **Cerebras** | `cerebras/llama-3.3-70b` | `CEREBRAS_API_KEY` | World-record inference (1000+ tok/s) |
| **SambaNova** | `sambanova/Meta-Llama-3.3-70B-Instruct` | `SAMBANOVA_API_KEY` | Blazing SN40L hardware speed |
| **Together AI** | `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` | `TOGETHER_API_KEY` | Fast open models & Turbo Llama |
| **DeepSeek** | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` | DeepSeek-V3 and DeepSeek-R1 |
| **OpenAI** | `openai/gpt-4o-mini` | `OPENAI_API_KEY` | GPT-4o, GPT-4o-mini, o1, o3-mini |
| **Google Gemini** | `google/gemini-2.0-flash` | `GEMINI_API_KEY` | Gemini 2.0 Flash / Pro |
| **Anthropic** | `anthropic/claude-3-5-sonnet-latest` | `ANTHROPIC_API_KEY` | Claude 3.5 Sonnet & Haiku |
| **xAI Grok** | `xai/grok-2-latest` | `XAI_API_KEY` | Grok-2 |
| **Mistral** | `mistral/mistral-large-latest` | `MISTRAL_API_KEY` | Mistral Large, Codestral |
| **Custom / OpenAI-compat** | `custom/<model>` | `CUSTOM_API_KEY` | Connect to any local or self-hosted API |

---

## ⚡ Performance Modes

### Low-Memory Mode (4GB RAM Linux / ChromeOS / Termux)
Designed specifically for resource-constrained systems:
- Caps V8 heap size to avoid Linux OOM-killer crashes.
- Employs compact command documentation and removes verbose block dumps from prompts.
- Periodically unloads distant chunks from world cache.

Run with:
```bash
npm run start:low-mem
# or: node main.js --low-memory
# or: ./start-low-memory.sh
```

### Fast Response Mode
Minimizes cooldown and latency:
- Eliminates the artificial 3-second delay between actions.
- Asynchronous background memory summarization.

Run with:
```bash
npm run start:fast
# or: node main.js --fast
```

---

## 💻 CLI Flags

| Flag | Alias | Description | Example |
| :--- | :--- | :--- | :--- |
| `--host <address>` | | Target Minecraft server hostname/IP and optional port | `--host ZCClanOnTOP.aternos.me:38410` |
| `--port <port>` | | Target Minecraft server port | `--port 25565` |
| `--now` | `-y`, `--yes` | Skip startup prompt and connect immediately | `npm start -- --now` |
| `--configure` | `--setup` | Launch the interactive terminal setup wizard | `node main.js --configure` |
| `--fast` | | Enable fast response mode (0ms cooldown) | `node main.js --fast` |
| `--low-memory` | | Optimize memory for 4GB RAM, Chromebooks, and Termux | `node main.js --low-memory` |
| `--profiles <paths...>`| | Specify one or more custom bot profiles | `--profiles ./andy.json` |
| `--help` | `-h` | Display command-line help | `node main.js --help` |

---

## 🎮 In-Game Commands

Once `Doombot` joins your world, speak to the bot directly in Minecraft chat:

```
Hello Doombot!
!goToPlayer <your_username>
!followPlayer <your_username>
!collectBlocks wood 10
!craftRecipe wooden_pickaxe
!givePlayer <your_username> wood 5
!stop
```

You can also view real-time agent status, chat history, and inventory from the web dashboard at:
👉 **`http://localhost:8080`** (`controlcenter:localhost`)

---

## 🛡️ License

This project is open-source under the MIT License.
