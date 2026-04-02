# Groups

NanoClaw organizes conversations into **groups** — each with isolated memory, session history, and CLAUDE.md context. There are two types: main and regular.

## Main group vs regular groups

| Behavior | Main group | Regular group |
|----------|-----------|---------------|
| Trigger required | Never — responds to every message | Yes, requires `@George` (or configured trigger) by default |
| System prompt | None — relies purely on CLAUDE.md files | `claude_code` preset + `groups/global/CLAUDE.md` appended |
| CLAUDE.md template | Copied from `groups/main/CLAUDE.md` | Copied from `groups/global/CLAUDE.md` |
| Remote control (`/remote-control`) | Allowed | Rejected |
| Can register new groups | Yes (via IPC) | No |

**Main group** is your personal direct chat — the assistant responds to every message, no trigger needed. Typically one per channel (e.g. `whatsapp_main`).

**Regular groups** are shared or topic-specific chats where the assistant sits silently and only responds when explicitly invoked with the trigger word. Each gets its own isolated filesystem, memory, and session history under `groups/{folder}/`.

## How to add a new group

The registration flow happens through the agent in your main chat.

**1. Create the chat**

Create a WhatsApp (or Telegram) group and add the number NanoClaw is running on.

**2. Find the group's chat ID**

Ask the agent from your main chat:
> "What's the chat ID for my Cooking group?"

The agent can use `mcp__nanoclaw__*` tools to list available groups and their JIDs.

**3. Register it**

Ask the agent:
> "Register my Cooking group with folder name `cooking` and trigger `@George`"

The agent issues a `register_group` IPC call. Only the main group is authorized to register new groups.

**4. Customize the CLAUDE.md**

A `groups/cooking/CLAUDE.md` is created automatically from the `groups/global/CLAUDE.md` template. Edit it to give the group its own context — persona, topic focus, dietary preferences, whatever fits the use case.

## Group filesystem layout

Each group gets an isolated directory:

```
groups/
  global/           # Shared template — persona, global instructions
    CLAUDE.md
  main/             # Template for main-group CLAUDE.md
    CLAUDE.md
  whatsapp_main/    # Your personal main chat
    CLAUDE.md       # Per-group memory (editable)
    logs/           # Container logs per invocation
  cooking/          # Example regular group
    CLAUDE.md
    logs/
```

Container mounts at runtime:
- `/workspace/group` → `groups/{folder}/` — the group's working directory and CLAUDE.md
- `/workspace/global` → `groups/global/` — shared persona (non-main groups only)
- `/workspace/project` → nanoclaw project root (readonly)

## System prompt layering

For a regular group, the agent receives context from multiple sources (in order):

1. **`claude_code` preset** — Claude Code's built-in tool and coding instructions
2. **`groups/global/CLAUDE.md`** — appended to the preset (persona, capabilities)
3. **`groups/{folder}/CLAUDE.md`** — per-group memory, loaded by the SDK via `cwd`
4. **`nanoclaw/CLAUDE.md`** — project-level instructions (readonly mount)
5. **Container skills** — `.claude/skills/` loaded inside the container (browser, formatting, etc.)

For the main group, the `claude_code` preset and `groups/global/CLAUDE.md` are skipped — the agent relies entirely on the CLAUDE.md files discovered via `settingSources`.
