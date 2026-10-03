# Autonomous Task Controller

Complex tasks run in an observe, plan, single-action, and verification loop instead of generating a command chain all at once.

## Usage

Describe a goal in Minecraft chat or on the Mindcraft control page:

```text
Andy, gather enough materials and craft a stone pickaxe.
Andy, find a safe location, prepare food, and build a temporary shelter.
```

The conversation model can delegate multi-step requests to `!goal("...")`. You can also start a goal directly:

```text
!goal("Gather materials and craft a stone pickaxe; finish when stone_pickaxe is present in the inventory")
```

View the current plan:

```text
!taskStatus
```

Stop the current goal:

```text
!endGoal
```

## Safety Limits

- Each iteration executes one command, then reads the world state again before planning the next step.
- Autonomous execution uses an explicit allowlist of bounded observation and in-game world-action commands.
- Process control, code generation, goal lifecycle, external content lookup, persistent mode changes, cross-agent conversation, player attack, restart-causing, and indefinitely running commands are rejected.
- Rejected commands count as failures and are never passed to the command executor.
- The controller stops after four consecutive failures, repeated actions without progress, or 60 executed steps.
- The plan, current step, and latest result are stored with the bot's memory and can be restored when `load_memory` is enabled.
- `!newAction` is never available to the autonomous controller, even if insecure coding is enabled for interactive use.
