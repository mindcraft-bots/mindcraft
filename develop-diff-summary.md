# Diff Summary vs develop

- Generated: 2026-05-03 20:30:51
- Branch: `native-tool` (`4ffd9f9`)
- Compared against: `develop` (`8acbd90`)
- Diff command: `git diff develop` (includes current working tree / uncommitted changes)

## Overall

| Metric | Value |
|---|---:|
| Files changed | 133 |
| Added files | 58 |
| Modified files | 52 |
| Deleted files | 23 |
| Renamed files | 0 |
| Shortstat | `133 files changed, 15090 insertions(+), 2787 deletions(-)` |

> Note: committed-only branch diff (`git diff develop...HEAD`) is:
> `133 files changed, 14822 insertions(+), 2766 deletions(-)`
> The difference comes from local uncommitted working-tree changes listed below.

## Current uncommitted changes

- ` M profiles/defaults/prompts/bot_responder.md`
- ` M settings.js`
- ` M src/agent/coder.js`
- ` M src/mindcraft/public/index.html`
- ` M src/models/codex_chatgpt/client.js`
- ` M src/models/prompter.js`
- ` M tests/agent_native_text_policy.test.js`
- ` M tests/codex_chatgpt.test.js`
- ` M tests/native_prompt_hygiene.test.js`

## Directory / area churn

| Area | Files | Additions | Deletions | Churn |
|---|---:|---:|---:|---:|
| `src/` | 63 | 9201 | 2266 | 11467 |
| `tests/` | 16 | 4247 | 0 | 4247 |
| `profiles/` | 39 | 749 | 453 | 1202 |
| `scripts/` | 3 | 496 | 0 | 496 |
| `settings_llm_providers.example.json` | 1 | 285 | 0 | 285 |
| `settings.js` | 1 | 62 | 27 | 89 |
| `andy.json` | 1 | 17 | 4 | 21 |
| `keys.example.json` | 1 | 0 | 19 | 19 |
| `package.json` | 1 | 7 | 4 | 11 |
| `eslint.config.js` | 1 | 6 | 3 | 9 |
| `tasks/` | 1 | 4 | 4 | 8 |
| `.gitignore` | 1 | 5 | 1 | 6 |
| `.dockerignore` | 1 | 4 | 1 | 5 |
| `README.md` | 1 | 2 | 3 | 5 |
| `main.js` | 1 | 4 | 1 | 5 |
| `FAQ.md` | 1 | 1 | 1 | 2 |

## Top churn files

| File | Additions | Deletions | Churn | Status |
|---|---:|---:|---:|---|
| `src/mindcraft/public/index.html` | 2649 | 41 | 2690 | M |
| `tests/agent_native_text_policy.test.js` | 1127 | 0 | 1127 | A |
| `tests/codex_chatgpt.test.js` | 1051 | 0 | 1051 | A |
| `src/models/codex_chatgpt/client.js` | 609 | 0 | 609 | A |
| `src/agent/history.js` | 574 | 29 | 603 | M |
| `src/models/native_tools.js` | 584 | 0 | 584 | A |
| `src/models/codex_chatgpt/auth.js` | 500 | 0 | 500 | A |
| `src/agent/agent.js` | 436 | 46 | 482 | M |
| `tests/chat_history_trace.test.js` | 439 | 0 | 439 | A |
| `src/models/prompter.js` | 310 | 79 | 389 | M |
| `tests/openai_compatible.test.js` | 389 | 0 | 389 | A |
| `tests/native_tools.test.js` | 370 | 0 | 370 | A |
| `src/mindcraft/public/chat_trace_projector.js` | 351 | 0 | 351 | A |
| `src/models/openai_compatible.js` | 329 | 0 | 329 | A |
| `src/models/codex_chatgpt/transport.js` | 288 | 0 | 288 | A |
| `settings_llm_providers.example.json` | 285 | 0 | 285 | A |
| `scripts/smoke/live_model_matrix.js` | 282 | 0 | 282 | A |
| `src/mindcraft/mindserver.js` | 263 | 7 | 270 | M |
| `src/models/google_generative_ai.js` | 266 | 0 | 266 | A |
| `src/models/replicate.js` | 206 | 56 | 262 | M |
| `profiles/defaults/_default.json` | 17 | 242 | 259 | M |
| `src/models/codex_chatgpt/protocol.js` | 249 | 0 | 249 | A |
| `tests/conversation_queue.test.js` | 188 | 0 | 188 | A |
| `src/models/gemini.js` | 0 | 176 | 176 | D |
| `src/models/_model_map.js` | 140 | 31 | 171 | M |
| `src/agent/commands/tool_adapter.js` | 170 | 0 | 170 | A |
| `scripts/smoke/live_function_call_smoke.js` | 169 | 0 | 169 | A |
| `src/agent/state_snapshot.js` | 152 | 0 | 152 | A |
| `src/models/gpt.js` | 0 | 147 | 147 | D |
| `tests/llm_providers_config.test.js` | 143 | 0 | 143 | A |
| `tests/mindserver_chat_history.test.js` | 138 | 0 | 138 | A |
| `src/agent/conversation.js` | 94 | 43 | 137 | M |
| `src/models/anthropic_messages.js` | 132 | 0 | 132 | A |
| `src/agent/library/skills.js` | 110 | 17 | 127 | M |
| `src/agent/react_message_manager.js` | 118 | 0 | 118 | A |
| `src/models/openai_responses.js` | 117 | 0 | 117 | A |
| `src/models/ollama.js` | 0 | 115 | 115 | D |
| `src/models/hyperbolic.js` | 0 | 114 | 114 | D |
| `profiles/defaults/prompts/coding.md` | 110 | 0 | 110 | A |
| `tests/native_prompt_hygiene.test.js` | 98 | 0 | 98 | A |

## Added files

- `profiles/cerebras.json` (+19/-0)
- `profiles/codex.json` (+25/-0)
- `profiles/defaults/prompts/bot_responder.md` (+11/-0)
- `profiles/defaults/prompts/coding.md` (+110/-0)
- `profiles/defaults/prompts/conversing.md` (+34/-0)
- `profiles/defaults/prompts/image_analysis.md` (+1/-0)
- `profiles/defaults/prompts/saving_memory.md` (+48/-0)
- `profiles/groq.json` (+19/-0)
- `profiles/kimi.json` (+19/-0)
- `profiles/minimax-cn.json` (+19/-0)
- `profiles/minimax-intl.json` (+19/-0)
- `profiles/novita.json` (+19/-0)
- `profiles/ollama.json` (+19/-0)
- `profiles/openrouter.json` (+19/-0)
- `profiles/qwen-cn.json` (+20/-0)
- `profiles/replicate.json` (+19/-0)
- `profiles/siliconflow.json` (+19/-0)
- `profiles/tasks/construction_prompt.md` (+14/-0)
- `profiles/tasks/cooking_prompt.md` (+19/-0)
- `profiles/tasks/crafting_prompt.md` (+14/-0)
- `scripts/smoke/dev_native_tool_loop.js` (+45/-0)
- `scripts/smoke/live_function_call_smoke.js` (+169/-0)
- `scripts/smoke/live_model_matrix.js` (+282/-0)
- `settings_llm_providers.example.json` (+285/-0)
- `src/agent/commands/tool_adapter.js` (+170/-0)
- `src/agent/react_message_manager.js` (+118/-0)
- `src/agent/state_snapshot.js` (+152/-0)
- `src/mindcraft/public/chat_trace_projector.js` (+351/-0)
- `src/models/anthropic_messages.js` (+132/-0)
- `src/models/azure_openai_responses.js` (+36/-0)
- `src/models/codex_chatgpt.js` (+15/-0)
- `src/models/codex_chatgpt/auth.js` (+500/-0)
- `src/models/codex_chatgpt/client.js` (+609/-0)
- `src/models/codex_chatgpt/constants.js` (+12/-0)
- `src/models/codex_chatgpt/protocol.js` (+249/-0)
- `src/models/codex_chatgpt/transport.js` (+288/-0)
- `src/models/codex_chatgpt/utils.js` (+86/-0)
- `src/models/google_generative_ai.js` (+266/-0)
- `src/models/native_tools.js` (+584/-0)
- `src/models/openai_compatible.js` (+329/-0)
- `src/models/openai_responses.js` (+117/-0)
- `src/models/token_usage.js` (+81/-0)
- `tests/agent_native_text_policy.test.js` (+1127/-0)
- `tests/chat_history_trace.test.js` (+439/-0)
- `tests/codex_chatgpt.test.js` (+1051/-0)
- `tests/conversation_queue.test.js` (+188/-0)
- `tests/llm_providers_config.test.js` (+143/-0)
- `tests/memory_summary_tool_history.test.js` (+25/-0)
- `tests/mindserver_chat_history.test.js` (+138/-0)
- `tests/mindserver_settings_spec.test.js` (+17/-0)
- `tests/native_prompt_hygiene.test.js` (+98/-0)
- `tests/native_tools.test.js` (+370/-0)
- `tests/openai_compatible.test.js` (+389/-0)
- `tests/profile_shape.test.js` (+97/-0)
- `tests/prompt_markdown_refs.test.js` (+18/-0)
- `tests/token_usage.test.js` (+50/-0)
- `tests/tool_result_policy.test.js` (+64/-0)
- `tests/vision_interpreter.test.js` (+33/-0)

## Deleted files

- `keys.example.json` (+0/-19)
- `profiles/qwen.json` (+0/-17)
- `src/models/azure.js` (+0/-32)
- `src/models/cerebras.js` (+0/-61)
- `src/models/claude.js` (+0/-87)
- `src/models/deepseek.js` (+0/-59)
- `src/models/gemini.js` (+0/-176)
- `src/models/glhf.js` (+0/-71)
- `src/models/gpt.js` (+0/-147)
- `src/models/grok.js` (+0/-82)
- `src/models/groq.js` (+0/-95)
- `src/models/huggingface.js` (+0/-86)
- `src/models/hyperbolic.js` (+0/-114)
- `src/models/lmstudio.js` (+0/-74)
- `src/models/mercury.js` (+0/-95)
- `src/models/mistral.js` (+0/-94)
- `src/models/novita.js` (+0/-71)
- `src/models/ollama.js` (+0/-115)
- `src/models/openrouter.js` (+0/-77)
- `src/models/qwen.js` (+0/-80)
- `src/models/vllm.js` (+0/-78)
- `src/utils/examples.js` (+0/-83)
- `src/utils/translator.js` (+0/-30)

## Modified files

### (root)

- `.dockerignore` (+4/-1)
- `.gitignore` (+5/-1)
- `FAQ.md` (+1/-1)
- `README.md` (+2/-3)
- `andy.json` (+17/-4)
- `eslint.config.js` (+6/-3)
- `main.js` (+4/-1)
- `package.json` (+7/-4)
- `settings.js` (+62/-27)

### profiles/

- `profiles/andy-4-reasoning.json` (+16/-11)
- `profiles/andy-4.json` (+16/-4)
- `profiles/azure.json` (+13/-13)
- `profiles/claude.json` (+17/-5)
- `profiles/claude_thinker.json` (+14/-4)
- `profiles/deepseek.json` (+17/-5)
- `profiles/defaults/_default.json` (+17/-242)
- `profiles/freeguy.json` (+18/-5)
- `profiles/gemini.json` (+17/-6)
- `profiles/gpt.json` (+16/-4)
- `profiles/grok.json` (+17/-5)
- `profiles/llama.json` (+17/-7)
- `profiles/mercury.json` (+17/-6)
- `profiles/mistral.json` (+17/-3)
- `profiles/tasks/construction_profile.json` (+5/-37)
- `profiles/tasks/cooking_profile.json` (+7/-6)
- `profiles/tasks/crafting_profile.json` (+7/-67)
- `profiles/vllm.json` (+15/-6)

### src/

- `src/agent/action_manager.js` (+32/-16)
- `src/agent/agent.js` (+436/-46)
- `src/agent/coder.js` (+40/-16)
- `src/agent/commands/actions.js` (+14/-11)
- `src/agent/commands/index.js` (+3/-2)
- `src/agent/conversation.js` (+94/-43)
- `src/agent/history.js` (+574/-29)
- `src/agent/library/skill_library.js` (+5/-0)
- `src/agent/library/skills.js` (+110/-17)
- `src/agent/mindserver_proxy.js` (+13/-0)
- `src/agent/modes.js` (+1/-0)
- `src/agent/self_prompter.js` (+9/-3)
- `src/agent/speak.js` (+63/-32)
- `src/agent/vision/vision_interpreter.js` (+16/-4)
- `src/mindcraft/mindcraft.js` (+5/-2)
- `src/mindcraft/mindserver.js` (+263/-7)
- `src/mindcraft/public/index.html` (+2649/-41)
- `src/mindcraft/public/settings_spec.json` (+31/-12)
- `src/models/_model_map.js` (+140/-31)
- `src/models/prompter.js` (+310/-79)
- `src/models/replicate.js` (+206/-56)
- `src/process/agent_process.js` (+3/-3)
- `src/utils/keys.js` (+35/-5)
- `src/utils/text.js` (+54/-4)

### tasks/

- `tasks/evaluation_script.py` (+4/-4)

## Review-oriented summary

- Biggest review surface is `src/`, especially runtime/chat UI, native tool plumbing, model adapters, and agent history/message flow.
- Test coverage was expanded substantially under `tests/` with new native-tool, provider, trace, queue, token-usage, and UI projection tests.
- Provider layer changed from many provider-specific files toward registry-driven adapters and shared protocol implementations.
- Prompt text moved into markdown files under `profiles/defaults/prompts/`, making prompt edits easier to review separately from code.
- Local uncommitted files are included in this report because the diff target is current worktree vs `develop`.

