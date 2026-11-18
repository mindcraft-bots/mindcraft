<h1 align="center">🧠mindcraft⛏️</h1>
<h1 align="center">
  <a href="https://trendshift.io/repositories/14816" target="_blank"><img src="https://trendshift.io/api/badge/repositories/14816" alt="mindcraft-bots%2Fmindcraft | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</h1>

<p align="center">Crafting minds for Minecraft with LLMs and <a href="https://prismarinejs.github.io/mineflayer/#/">Mineflayer!</a></p>

<p align="center">
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md">FAQ</a> | 
  <a href="https://discord.gg/mp73p35dzC">Discord Support</a> | 
  <a href="https://www.youtube.com/watch?v=gRotoL8P8D8">Video Tutorial</a> | 
  <a href="https://kolbynottingham.com/mindcraft/">Blog Post</a> | 
  <a href="https://mindcraft-minecollab.github.io/index.html">Paper Website</a> | 
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/minecollab.md">MineCollab</a>
</p>

> [!Caution]
Do not connect this bot to public servers with coding enabled. This project allows an LLM to write/execute code on your computer. The code is sandboxed, but still vulnerable to injection attacks. Code writing is disabled by default, you can enable it by setting `allow_insecure_coding` to `true` in `settings.js`. Ye be warned.

# Getting Started
## Requirements

- [Minecraft Java Edition](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) (up to v1.21.11, recommend v1.21.6)
- [Node.js Installed](https://nodejs.org/) (Node v18 or v20 LTS recommended. Node v24+ may cause issues with native dependencies)
- At least one API key from a supported API provider. See [supported APIs](#model-customization). OpenAI is the default.

> [!Important]
> If installing node on windows, ensure you check `Automatically install the necessary tools`
>
> If you encounter `npm install` errors on macOS, see the [FAQ](FAQ.md#common-issues) for troubleshooting native module build issues

## Install and Run

1. Make sure you have the requirements above.

2. Download the [latest release](https://github.com/mindcraft-bots/mindcraft/releases/latest) and unzip it, or clone the repository.

3. In terminal/command prompt, run:
   ```bash
   npm install --omit=optional
   ```

4. **Interactive Setup Wizard**: Run the terminal setup wizard to configure your API key, bot name, server host/port, and performance options:
   ```bash
   npm run configure
   # or: node setup.js
   ```
   *(Alternatively, `node main.js` will automatically launch the setup wizard if no API key is detected!)*

5. Start a Minecraft world and open it to LAN on port `55916` (or join any server).

6. Run the bot:
   ```bash
   node main.js
   # or for Linux 4GB: npm run start:low-mem
   # or for Termux:    npm run start:termux
   ```

If you encounter issues, check the [FAQ](https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md) or find support on [discord](https://discord.gg/mp73p35dzC). We are currently not very responsive to github issues. To run tasks please refer to [Minecollab Instructions](minecollab.md#installation)


# Configuration
## Model Customization

You can configure project details in `settings.js`. [See file.](settings.js)

You can configure the agent's name, model, and prompts in their profile like `andy.json`. The model can be specified with the `model` field, with values like `model: "gemini-2.5-pro"`. You will need the correct API key for the API provider you choose. See all supported APIs below.

<details>
<summary><strong>⭐ VIEW SUPPORTED APIs (50+ Options) ⭐</strong></summary>

| API Name | Config Variable | Docs / Info |
|------|------|------|
| `groq` | `GROQCLOUD_API_KEY` (or `GROQ_API_KEY`) | [docs](https://console.groq.com/docs/models) (Ultra-fast Llama-3.3-70B) |
| `cerebras` | `CEREBRAS_API_KEY` | [docs](https://inference-docs.cerebras.ai/introduction) (World-record speed) |
| `sambanova` | `SAMBANOVA_API_KEY` | [docs](https://sambanova.ai/) (Ultra-fast SN40L inference) |
| `together` | `TOGETHER_API_KEY` | [docs](https://docs.together.ai/) (Fast Llama-3.3 Turbo & DeepSeek) |
| `deepseek` | `DEEPSEEK_API_KEY` | [docs](https://api-docs.deepseek.com/) (DeepSeek V3 / R1) |
| `openai` | `OPENAI_API_KEY` | [docs](https://platform.openai.com/docs/models) (GPT-4o, GPT-4o-mini, o1, o3-mini) |
| `google` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | [docs](https://ai.google.dev/gemini-api/docs/models/gemini) (Gemini 2.0 Flash) |
| `anthropic` | `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) | [docs](https://docs.anthropic.com/claude/docs/models-overview) (Claude 3.5 Sonnet) |
| `xai` | `XAI_API_KEY` (or `GROK_API_KEY`) | [docs](https://docs.x.ai/docs) (Grok-2) |
| `mistral` | `MISTRAL_API_KEY` (or `CODESTRAL_API_KEY`) | [docs](https://docs.mistral.ai/getting-started/models/models_overview/) |
| `fireworks` | `FIREWORKS_API_KEY` | [docs](https://fireworks.ai/) (Low-latency Llama-3.3 & Vision) |
| `deepinfra` | `DEEPINFRA_API_KEY` | [docs](https://deepinfra.com/) (Fast, affordable inference) |
| `perplexity` | `PERPLEXITY_API_KEY` | [docs](https://docs.perplexity.ai/) (Sonar models) |
| `cohere` | `COHERE_API_KEY` | [docs](https://docs.cohere.com/) (Command R / Command R+) |
| `qwen` | `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`) | [docs](https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api) |
| `siliconflow` | `SILICONFLOW_API_KEY` | [docs](https://siliconflow.cn/) (Fast DeepSeek & Qwen) |
| `openrouter` | `OPENROUTER_API_KEY` | [docs](https://openrouter.ai/models) (Aggregated 200+ models) |
| `hyperbolic` | `HYPERBOLIC_API_KEY` | [docs](https://docs.hyperbolic.xyz/docs/getting-started) |
| `novita` | `NOVITA_API_KEY` | [docs](https://novita.ai/model-api/product/llm-api) |
| `huggingface` | `HUGGINGFACE_API_KEY` | [docs](https://huggingface.co/models) |
| `replicate` | `REPLICATE_API_KEY` | [docs](https://replicate.com/collections/language-models) |
| `mercury` | `MERCURY_API_KEY` | [docs](https://www.inceptionlabs.ai/) |
| `azure` | `AZURE_OPENAI_API_KEY` | [docs](https://azure.microsoft.com/) |
| `minimax` | `MINIMAX_API_KEY` | [docs](https://www.minimaxi.com/) (MiniMax-Text-01) |
| `moonshot` | `MOONSHOT_API_KEY` (or `KIMI_API_KEY`) | [docs](https://platform.moonshot.cn/) (Kimi moonshot-v1) |
| `zhipu` | `ZHIPU_API_KEY` (or `GLM_API_KEY`) | [docs](https://open.bigmodel.cn/) (GLM-4-Plus, GLM-4-Flash) |
| `baichuan` | `BAICHUAN_API_KEY` | [docs](https://platform.baichuan-ai.com/) (Baichuan 4) |
| `yi` | `YI_API_KEY` | [docs](https://platform.lingyiwanwu.com/) (Yi-Lightning) |
| `stepfun` | `STEPFUN_API_KEY` | [docs](https://platform.stepfun.com/) (Step-1, Step-2) |
| `internlm` | `INTERNLM_API_KEY` | [docs](https://internlm.intern-ai.org.cn/) (InternLM 2.5) |
| `ai21` | `AI21_API_KEY` | [docs](https://www.ai21.com/) (Jamba 1.5 Large & Mini) |
| `cloudflare` | `CLOUDFLARE_API_KEY` | [docs](https://developers.cloudflare.com/workers-ai/) |
| `anyscale` | `ANYSCALE_API_KEY` | [docs](https://docs.endpoints.anyscale.com/) |
| `octoai` | `OCTOAI_API_KEY` | [docs](https://octo.ai/) |
| `lepton` | `LEPTON_API_KEY` | [docs](https://www.lepton.ai/) |
| `scaleway` | `SCALEWAY_API_KEY` | [docs](https://www.scaleway.com/en/ai-apis/) |
| `monsterapi` | `MONSTERAPI_API_KEY` | [docs](https://monsterapi.ai/) |
| `nebius` | `NEBIUS_API_KEY` | [docs](https://nebius.com/studio) |
| `ovh` | `OVH_API_KEY` | [docs](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/) |
| `upstage` | `UPSTAGE_API_KEY` | [docs](https://www.upstage.ai/) (Solar Pro) |
| `friendli` | `FRIENDLI_API_KEY` | [docs](https://friendli.ai/) |
| `lambda` | `LAMBDA_API_KEY` | [docs](https://lambdalabs.com/service/gpu-cloud/inference) |
| `voyage` | `VOYAGE_API_KEY` | [docs](https://www.voyageai.com/) |
| `writer` | `WRITER_API_KEY` | [docs](https://writer.com/) (Palmyra X 004) |
| `shuttle` | `SHUTTLE_API_KEY` | [docs](https://shuttleai.com/) |
| `aimlapi` | `AIMLAPI_API_KEY` | [docs](https://aimlapi.com/) |
| `infinence` | `INFINENCE_API_KEY` | [docs](https://infinence.ai/) |
| `chutes` | `CHUTES_API_KEY` | [docs](https://chutes.ai/) |
| `kluster` | `KLUSTER_API_KEY` | [docs](https://kluster.ai/) |
| `glhf` | `GLHF_API_KEY` | [docs](https://glhf.chat/) |
| `ollama` (local) | `OLLAMA_API_KEY` (optional) | [docs](https://ollama.com/library) (Offline, no key needed) |
| `lmstudio` (local) | `LMSTUDIO_API_KEY` (optional) | [docs](https://lmstudio.ai/) (Offline, localhost:1234) |
| `vllm` (local) | `VLLM_API_KEY` (optional) | [docs](https://docs.vllm.ai/) (Offline, localhost:8000) |
| `localai` (local) | `LOCALAI_API_KEY` (optional) | [docs](https://localai.io/) (Offline, localhost:8080) |
| `jan` (local) | `JAN_API_KEY` (optional) | [docs](https://jan.ai/) (Offline, localhost:1337) |
| `textgen` (local) | `TEXTGEN_API_KEY` (optional) | [docs](https://github.com/oobabooga/text-generation-webui) (localhost:5000) |
| `kobold` (local) | `KOBOLD_API_KEY` (optional) | [docs](https://koboldai.org/) (Offline, localhost:5001) |
| `custom` | `CUSTOM_API_KEY`, `CUSTOM_API_URL` | Connect to ANY OpenAI-compatible server |

</details>

### Multi-Key Support & Key Rotation
You can provide **multiple API keys** for any provider in `keys.json` or environment variables:
- **As an array**: `"GROQCLOUD_API_KEY": ["gsk_key1...", "gsk_key2...", "gsk_key3..."]`
- **As comma-separated string**: `"GROQCLOUD_API_KEY": "gsk_key1, gsk_key2, gsk_key3"`
- **As numbered environment variables**: `GROQCLOUD_API_KEY_1`, `GROQCLOUD_API_KEY_2`, etc.

When multiple keys are provided, Mindcraft automatically rotates keys when rate limits (HTTP 429) or quota errors are encountered, keeping your bots running smoothly without disconnects!

## ⚡ Fast Mode & Maximum Performance
To achieve the fastest possible bot responses while maintaining high gameplay reasoning and command accuracy:
1. **Choose an ultra-fast model provider**:
   - **Groq** (`groq/llama-3.3-70b-versatile`): ~300 tokens/sec, near-instant bot reactions.
   - **Cerebras** (`cerebras/llama-3.3-70b`): 1000+ tokens/sec, world-record inference latency.
   - **SambaNova** (`sambanova/Meta-Llama-3.3-70B-Instruct`): 200+ tokens/sec on SN40L hardware.
   - **Together AI** (`together/meta-llama/Llama-3.3-70B-Instruct-Turbo`): Ultra-fast and accurate.
2. **Use pre-configured fast profiles**:
   ```bash
   node main.js --profiles ./profiles/fast.json
   ```
   Or use `./profiles/cerebras.json`, `./profiles/sambanova.json`, or `./profiles/groq.json`.
3. **Fast mode features**:
   - Cooldown is set to 0 (no artificial 3-second delay).
   - Memory summarization runs asynchronously in the background so player chat responses are not blocked.
   - Run with `npm run start:fast` or `--fast`.

## 🐧 Linux 4GB RAM Optimization
Mindcraft is optimized to run smoothly on Linux machines with 4GB of RAM or less:
- **Constrained V8 heap size** (`--max-old-space-size=1536` for mindserver, `1024` per agent) prevents Linux OOM (Out Of Memory) killer crashes.
- **Automatic chunk pruning**: Periodically unloads distant chunks from Mineflayer's world cache so long bot sessions don't bloat memory.
- **Aggressive Garbage Collection**: Automatic GC after memory saves and periodic cleanup.
- **Run low memory mode**:
  ```bash
  npm run start:low-mem
  # or
  ./start-low-memory.sh
  # or
  node --max-old-space-size=1536 main.js --low-memory
  ```

## 📱 Termux (Android) Support
Mindcraft can run directly inside Termux on Android phones and tablets!

### 1. One-Step Setup
In the Termux terminal, run:
```bash
chmod +x termux-setup.sh
./termux-setup.sh
```
This automatically updates packages, installs Node.js LTS, Git, and Python, and installs dependencies without desktop-only native C++/X11 modules (`canvas`, `gl`).

### 2. Configure Keys
Add your API key (such as `GROQCLOUD_API_KEY` or `OPENAI_API_KEY`) to `keys.json`:
```bash
nano keys.json
```

### 3. Start the Bot
```bash
./termux-start.sh
# or
npm run start:termux
```
- Browser auto-open is disabled automatically on Termux. The MindServer UI is hosted at `http://localhost:8080`.
- Memory is capped at 1024MB to avoid Android OS killing background apps.
- Native canvas/webgl is safely bypassed without throwing errors.

For more comprehensive model configuration and syntax, see [Model Specifications](#model-specifications).

For local models we support [ollama](https://ollama.com/) and we provide our own finetuned models for you to use. 
To install our models, install ollama and run the following terminal command:
```bash
ollama pull sweaterdog/andy-4:micro-q8_0 && ollama pull embeddinggemma
```

## Online Servers
To connect to online servers your bot will need an official Microsoft/Minecraft account. You can use your own personal one, but will need another account if you want to connect too and play with it. To connect, change these lines in `settings.js`:
```javascript
"host": "111.222.333.444",
"port": 55920,
"auth": "microsoft",

// rest is same...
```
> [!Important]
> The bot's name in the profile.json must exactly match the Minecraft profile name! Otherwise the bot will spam talk to itself.

To use different accounts, Mindcraft will connect with the account that the Minecraft launcher is currently using. You can switch accounts in the launcher, then run `node main.js`, then switch to your main account after the bot has connected.

## Tasks

Tasks automatically start the bot with a prompt and a goal item to acquire or blueprint to construct. To run a simple task that involves collecting 4 oak_logs run 

`node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs`

Here is an example task json format: 

```
{
    "gather_oak_logs": {
      "goal": "Collect at least four logs",
      "initial_inventory": {
        "0": {
          "wooden_axe": 1
        }
      },
      "agent_count": 1,
      "target": "oak_log",
      "number_of_target": 4,
      "type": "techtree",
      "max_depth": 1,
      "depth": 0,
      "timeout": 300,
      "blocked_actions": {
        "0": [],
        "1": []
      },
      "missing_items": [],
      "requires_ctable": false
    }
}
```

The `initial_inventory` is what the bot will have at the start of the episode, `target` refers to the target item and `number_of_target` refers to the number of target items the agent needs to collect to successfully complete the task. 

If you want more optimization and automatic launching of the minecraft world, you will need to follow the instructions in [Minecollab Instructions](minecollab.md#installation)

## Docker Container

If you intend to `allow_insecure_coding`, it is a good idea to run the app in a docker container to reduce risks of running unknown code. This is strongly recommended before connecting to remote servers, although still does not guarantee complete safety.

```bash
docker build -t mindcraft . && docker run --rm --add-host=host.docker.internal:host-gateway -p 8080:8080 -p 3000-3003:3000-3003 -e SETTINGS_JSON='{"auto_open_ui":false,"profiles":["./profiles/gemini.json"],"host":"host.docker.internal"}' --volume ./keys.json:/app/keys.json --name mindcraft mindcraft
```
or simply
```bash
docker-compose up --build
```

When running in docker, if you want the bot to join your local minecraft server, you have to use a special host address `host.docker.internal` to call your localhost from inside your docker container. Put this into your [settings.js](settings.js):

```javascript
"host": "host.docker.internal", // instead of "localhost", to join your local minecraft from inside the docker container
```

To connect to an unsupported minecraft version, you can try to use [viaproxy](services/viaproxy/README.md)

# Bot Profiles

Bot profiles are json files (such as `andy.json`) that define:

1. Bot backend LLMs to use for talking, coding, and embedding.
2. Prompts used to influence the bot's behavior.
3. Examples help the bot perform tasks.

## Model Specifications

LLM models can be specified simply as `"model": "gpt-5.4"`, or more specifically with `"{api}/{model}"`, like `"openrouter/google/gemini-2.5-pro"`. See all supported APIs [here](#model-customization).

The `model` field can be a string or an object. A model object must specify an `api`, and optionally a `model`, `url`, and additional `params`. You can also use different models/providers for chatting, coding, vision, embedding, and voice synthesis. See the example below.

```json
"model": {
  "api": "openai",
  "model": "gpt-5.4",
  "url": "https://api.openai.com/v1/",
  "params": {
    "max_tokens": 1000,
    "temperature": 1
  }
},
"code_model": {
  "api": "openai",
  "model": "gpt-5.4-mini",
  "url": "https://api.openai.com/v1/"
},
"vision_model": {
  "api": "openai",
  "model": "gpt-5.4",
  "url": "https://api.openai.com/v1/"
},
"embedding": {
  "api": "openai",
  "url": "https://api.openai.com/v1/",
  "model": "text-embedding-3-small"
},
"speak_model": "openai/tts-1/echo"
```

`model` is used for chat, `code_model` is used for newAction coding, `vision_model` is used for image interpretation, `embedding` is used to embed text for example selection, and `speak_model` is used for voice synthesis. `model` will be used by default for all other models if not specified. Not all APIs support embeddings, vision, or voice synthesis.

All apis have default models and urls, so those fields are optional. The `params` field is optional and can be used to specify additional parameters for the model. It accepts any key-value pairs supported by the api. Is not supported for embedding models.

## Embedding Models

Embedding models are used to embed and efficiently select relevant examples for conversation and coding.

Supported Embedding APIs: `openai`, `google`, `replicate`, `huggingface`, `novita`

If you try to use an unsupported model, then it will default to a simple word-overlap method. Expect reduced performance. We recommend using supported embedding APIs.

## Voice Synthesis Models

Voice synthesis models are used to narrate bot responses and specified with `speak_model`. This field is parsed differently than other models and only supports strings formatted as `"{api}/{model}/{voice}"`, like `"openai/tts-1/echo"`. We only support `openai` and `google` for voice synthesis.

## Specifying Profiles via Command Line

By default, the program will use the profiles specified in `settings.js`. You can specify one or more agent profiles using the `--profiles` argument: `node main.js --profiles ./profiles/andy.json ./profiles/jill.json`


# Contributing

We welcome contributions to the project! We are generally less responsive to github issues, and more responsive to pull requests. Join the [discord](https://discord.gg/mp73p35dzC) for more active support and direction.

While AI generated code is allowed, please vet it carefully. Submitting tons of sloppy code and documentation actively harms development.

## Patches

Some of the node modules that we depend on have bugs in them. To add a patch, change your local node module file and run `npx patch-package [package-name]`

## Development Team
Thanks to all who contributed to the project, especially the official development team: [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), [@kolbytn](https://github.com/kolbytn), [@icwhite](https://github.com/icwhite), [@Sweaterdog](https://github.com/Sweaterdog), [@Ninot1Quyi](https://github.com/Ninot1Quyi), [@riqvip](https://github.com/riqvip), [@uukelele](https://github.com/uukelele), [@mrelmida](https://github.com/mrelmida)


## Citation:
This work is published in the paper [Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning](https://arxiv.org/abs/2504.17950). Please use this citation if you use this project in your research:
```
@article{mindcraft2025,
  title = {Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning},
  author = {White*, Isadora and Nottingham*, Kolby and Maniar, Ayush and Robinson, Max and Lillemark, Hansen and Maheshwari, Mehul and Qin, Lianhui and Ammanabrolu, Prithviraj},
  journal = {arXiv preprint arXiv:2504.17950},
  year = {2025},
  url = {https://arxiv.org/abs/2504.17950},
}
```

## Contributors

Thanks to everyone who has submitted issues on and off Github, made suggestions, and generally helped make this a better project.

![Contributors](https://contrib.rocks/image?repo=mindcraft-bots/mindcraft)
