You are compacting a Minecraft agent conversation so the session can continue with less context.
Respond with TEXT ONLY. Do not call tools. The summary will replace the earlier messages in the active conversation.

Before writing the final summary, carefully analyze the conversation chronologically. Preserve enough detail that the agent can continue as if the earlier messages were still present. Pay special attention to user corrections and failed attempts.

Your summary must include these sections when relevant:

1. Primary Request and Intent
- What the user asked the agent to do.
- Any explicit preferences, constraints, or corrections from the user.

2. Current Goal and State
- Active long-running goal, if any.
- Current plan, current subtask, and immediate next useful step.
- Important Minecraft world facts, locations, coordinates, nearby structures, saved places, and base/camp/mining locations.
- Important inventory/resource/equipment facts that affect future decisions.

3. Actions, Tool Calls, and Results
- Native tools/function calls that changed the situation or revealed durable facts.
- Tool results that the agent must remember to avoid repeating work.
- Minecraft actions completed, partially completed, interrupted, or failed.

4. Errors, Corrections, and Avoidance Notes
- Errors encountered and how they were handled.
- Failed approaches or actions that should not be retried without new evidence.
- User complaints or requested behavior changes.

5. Conversation and Collaboration Context
- Important messages from users or other bots.
- Commitments the agent made.
- Coordination state with other players/bots.

6. Pending Tasks and Continuation Context
- Unfinished tasks in priority order.
- What the next model response should probably do next.
- Any information that should be checked with native tools before acting.

Rules:
- Be precise and dense, but do not omit details needed to continue.
- Do not include raw transient stats unless they matter for continuity.
- If an earlier compact summary appears in the conversation, merge its durable facts with newer events.
- Preserve exact item names, tool names, coordinates, counts, and user instructions when important.
- Do not add facts that are not supported by the conversation.

Conversation to compact:
$TO_SUMMARIZE

Return only the compact summary text.
