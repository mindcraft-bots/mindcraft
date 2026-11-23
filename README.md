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
- [Node.js Installed](https://nodejs.org/) (Node 22 recommended; the installed Mineflayer dependency requires Node 22 or newer. Node v24+ may cause issues with native dependencies.)
- At least one API key from a supported API provider. See [supported APIs](#model-customization). OpenAI is the default.

> [!Important]
> If installing node on windows, ensure you check `Automatically install the necessary tools`
>
> If you encounter `npm install` errors on macOS, see the [FAQ](FAQ.md#common-issues) for troubleshooting native module build issues

## Install and Run

1. Make sure you have the requirements above.

2. Download the [latest release](https://github.com/mindcraft-bots/mindcraft/releases/latest) and unzip it, or clone the repository.

3. Rename `keys.example.json` to `keys.json` and fill in your API keys (you only need one). The desired model is set in `andy.json` or other profiles. For other models refer to the table below.

4. In terminal/command prompt, run `npm install` from the installed directory

5. Start a minecraft world and open it to LAN on localhost port `55916`

6. Run `node main.js` from the installed directory

If you encounter issues, check the [FAQ](https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md) or find support on [discord](https://discord.gg/mp73p35dzC). We are currently not very responsive to github issues. To run tasks please refer to [Minecollab Instructions](minecollab.md#installation)

## Build from a schematic

Mindcraft builds supported schematic files from [`schematics/schems/packN/`](schematics/schems/) and legacy files placed directly in [`schematics/`](schematics/). `!listSchematics` shows pack, screenshot-folder group, stable **file ID**, and exact **file name** as separate fields. Each file ID is a persistent mapping within its pack, for example in [`schematics/schems/pack1/index.json`](schematics/schems/pack1/index.json), not a sorted position. Pack1 is an example, not a requirement for reusable tooling. Direct commands use `pack:group:fileId`; for example [`!buildSchematic("pack1:02:01")`](src/agent/commands/actions.js:492) selects group 02, file ID 01. An explicitly addressed typed request such as `/msg Andy Andy build file id 01 from group 02 of pack1` selects that same entry. Human selectors also accept `id` for **file id**, `file` for **file name**, and `schema`, `schem`, `scheme`, or `schematic` as selector prefixes or filename-selector substitutes; exact forms and restrictions are in the [schematic building guide](schematics/README.md). Typed parser/listing objects use `fileId` and `fileName`; legacy `id` and `filename` fields remain mapped aliases for existing consumers. The script command still takes its filename selector first, followed by optional `x`, `y`, and `z`. This is a narrow typed route, not arbitrary natural-language intent recognition. Direct commands and routed requests are limited to configured trusted command senders; a non-empty `only_chat_with` list also needs to allow the sender. The bot needs permission to switch into Creative mode; on permission-managed servers, grant applicable least-privilege game-mode nodes rather than `/op`.

The index names a logical base; with a known engine version, numeric and base-name selectors choose the highest known compatible release variant, and `!listSchematics` identifies the selected file and version. For example, the bee selects `02_bee_hot_air_balloon.mc1.21.4.schem` on 1.21.4 and `02_bee_hot_air_balloon.mc26.1.schem` on 26.1. Version eligibility is not a guarantee of palette compatibility or successful placement. The 30 original pack1 files are retained; 60 separate derivatives and conversion reports were generated without overwriting them. See the [compiler guide](schematics/tooling/BLUEPRINT_TOOLING.md) and [symmetry guide](schematics/tooling/SYMMETRY.md) for reviewed history, pack compilation, and the wardrobe repair.

Explicit placement coordinates are available only on the direct command: [`!buildSchematic("pack1:01:01", 100, 64, -20)`](src/agent/commands/actions.js:492). Supply all three finite coordinates or omit all three; human typed requests do not accept coordinates. Use [`!stop`](src/agent/commands/actions.js:54) to cancel an active build. Eligible hostile-mob self-preservation, cowardice, or self-defense interruptions can resume automatically at the original schematic and origin after cleanup and world/block-state checks; trusted user commands, replacement actions, failures, death, disconnects, and world changes cancel the retry. See the [schematic building guide](schematics/README.md) for exact recovery policy, supported human and script forms, file formats, stable index maintenance, placement details, security restrictions, and reusable prompts. After changing application source, rebuild and recreate the Docker image; restarting an existing image does not load source changes.

For safety, schematics containing doors, beds, or known two-cell/tall plants are currently rejected before mutation because their complete orientation-dependent secondary placement footprints are not modeled. Waterlogged/fluid-bearing natural obstruction states are also refused. Actual Mineflayer respawn events invalidate active builds and recovery even when the dimension and world/entity references appear unchanged; details and limitations are in the [schematic building guide](schematics/README.md).

From the repository root, `npm run test:schematic` recursively discovers the full schematic suite, including pack-specific tests. The pack audit `python3 schematics/tooling/audit_batch.py --pack pack1 --minecraft-version 1.21.4 --data-version 4189 --output-dir tmp/pack1-audit-new` is an example that writes to a new isolated directory. The prior [`schematics/tooling/validation/pack1/batch_validation.json`](schematics/tooling/validation/pack1/batch_validation.json) is historical evidence; see the [compiler guide](schematics/tooling/BLUEPRINT_TOOLING.md). Potted plants and multi-cell placements remain limited, and registry or simulated tests do not establish live-server compatibility. The request parser and command documentation are in [`src/agent/schematic_request.js`](src/agent/schematic_request.js) and [`src/agent/commands/actions.js`](src/agent/commands/actions.js); `!listSchematics` is described in [`src/agent/commands/queries.js`](src/agent/commands/queries.js). For Docker, rebuild and recreate the relevant services (for example, `docker compose up -d --build`); source is baked into the image.


# Configuration
## Model Customization

You can configure project details in `settings.js`. [See file.](settings.js)

You can configure the agent's name, model, and prompts in their profile like `andy.json`. The model can be specified with the `model` field, with values like `model: "gemini-2.5-pro"`. You will need the correct API key for the API provider you choose. See all supported APIs below.

<details>
<summary><strong>⭐ VIEW SUPPORTED APIs ⭐</strong></summary>

| API Name | Config Variable| Docs |
|------|------|------|
| `openai` | `OPENAI_API_KEY` | [docs](https://platform.openai.com/docs/models) |
| `google` | `GEMINI_API_KEY` | [docs](https://ai.google.dev/gemini-api/docs/models/gemini) |
| `anthropic` | `ANTHROPIC_API_KEY` | [docs](https://docs.anthropic.com/claude/docs/models-overview) |
| `xai` | `XAI_API_KEY` | [docs](https://docs.x.ai/docs) |
| `deepseek` | `DEEPSEEK_API_KEY` | [docs](https://api-docs.deepseek.com/) |
| `ollama` (local) | n/a | [docs](https://ollama.com/library) |
| `qwen` | `QWEN_API_KEY` | [Intl.](https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api)/[cn](https://help.aliyun.com/zh/model-studio/getting-started/models) |
| `mistral` | `MISTRAL_API_KEY` | [docs](https://docs.mistral.ai/getting-started/models/models_overview/) |
| `replicate` | `REPLICATE_API_KEY` | [docs](https://replicate.com/collections/language-models) |
| `groq` (not grok) | `GROQCLOUD_API_KEY` | [docs](https://console.groq.com/docs/models) |
| `huggingface` | `HUGGINGFACE_API_KEY` | [docs](https://huggingface.co/models) |
| `novita` | `NOVITA_API_KEY` | [docs](https://novita.ai/model-api/product/llm-api?utm_source=github_mindcraft&utm_medium=github_readme&utm_campaign=link) |
| `openrouter` | `OPENROUTER_API_KEY` | [docs](https://openrouter.ai/models) |
| `hyperbolic` | `HYPERBOLIC_API_KEY` | [docs](https://docs.hyperbolic.xyz/docs/getting-started) |
| `vllm` | n/a | n/a |
| `cerebras` | `CEREBRAS_API_KEY` | [docs](https://inference-docs.cerebras.ai/introduction) |
| `mercury` | `MERCURY_API_KEY` | [docs](https://www.inceptionlabs.ai/) |

</details>

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

## Transfer reviewed updates to another Docker host

Use Git to move reviewed project changes between clones rather than copying the whole working directory. Commit the intended changes, inspect the commit, then push the exact tracked branch to the intended repository/fork. On the destination, configure that clone's intended remote and branch as its Git upstream; [`scripts/update_project.sh`](scripts/update_project.sh) derives both from the current checkout and never assumes a remote name or branch. It does not push, switch branches, install dependencies, run `rsync`, or build/deploy Docker images. See the [script naming and migration guide](scripts/README.md) for renamed commands.

The script is not available in an old target clone until its first update. For that bootstrap, reconcile and back up the target manually first, review its remote/branch and all local tracked, untracked, and ignored runtime data, then use the target's normal reviewed Git procedure to obtain this script. Do not use the script to bypass that initial review. Before applying later updates, review the target host's configuration: clean tracked files can still be replaced by a fast-forward, and some tracked host-specific settings/profile files may differ from what the destination needs.

From the repository root, after reviewing and backing up the destination state, the update/build/recreate chain for the two Compose bot services is:

```sh
scripts/update_project.sh --apply && docker compose build bot-andy bot-alice && docker compose up -d --force-recreate bot-andy bot-alice
```

Because the commands use `&&`, a blocked or failed update stops the chain before Docker build/deployment. Verify the services and inspect fresh startup logs locally:

```sh
docker compose ps bot-andy bot-alice
docker compose logs --tail=100 bot-andy bot-alice
```

[`scripts/update_project.sh --check`](scripts/update_project.sh) is an offline check against the locally cached upstream-tracking ref; it does not contact the remote, refresh the index, or establish whether that ref is fresh. It is not an incoming-file/deployment safety preview. `--apply` fetches only the configured branch into its tracking ref, disables opportunistic ref mappings, tag updates, pruning, submodule recursion, and automatic maintenance, and only permits a clean, non-shallow, non-sparse, non-partial named checkout to fast-forward exactly to the fetched upstream commit. It refuses local changes, untracked files, ahead/diverged history, configured checkout filters, and unsafe Git states; it does not clean, reset, stash, rebase, force-push, merge-commit, or intentionally overwrite ignored files. Git's no-overwrite-ignore protection refuses ignored-path collisions, including parent directory/file/symlink collisions tested with Git 2.53.0. A general filesystem/I/O failure or interruption can still leave partial checkout changes: failure is not proof of rollback. Inspect HEAD, index, and files before retrying; do not automatically reset/clean. This is not an atomic transaction and cannot protect against unrelated processes writing to the checkout concurrently; the advisory lock coordinates only this updater in that worktree. Inspect the script's documented limitations in [`schematics/README.md`](schematics/README.md#safe-code-updates-and-docker-redeployment).

Git transfers committed/tracked assets, including schematic indexes, binaries, blueprints, screenshots, source and tests. Verify intended assets are tracked (`git ls-files`) and handle Git LFS or submodules explicitly if introduced; this updater refuses submodules and LFS pointer content. Ignored files do not transfer: provision `keys.json` and other credentials securely, and intentionally migrate bot histories/state or dependencies only when needed. If using `rsync` for selected operational data, stop writers first, use a dry run, review each selected path, and never use `--delete` or blanket-copy `.git`, dependencies, credentials, or bot state. The ignored `package-lock.json` also means this workflow does not guarantee reproducible dependency resolution or image builds.

The Dockerfile copies application source into the image; these two services do not bind-mount that source, so updating host source alone does not update a running container: rebuild and recreate it. The Compose file does bind-mount schematic assets, settings, profiles, credentials, and bot state from the destination host; mounted host contents take precedence over corresponding image contents at runtime. The current `.dockerignore` excludes `keys.json` but does not exclude `.git`, so Git metadata (potentially including credential-bearing remote configuration) can enter the build context/image. Review that separately before building; the updater does not change Docker-context policy. A successful Git update does not validate host configuration, secrets, bind-mounted data, or the resulting image, and it does not guarantee a safe/reproducible build. Never publish credentials or complete history/model logs when sharing status or logs.

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
