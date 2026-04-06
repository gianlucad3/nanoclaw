---
name: compact_memory
description: Trigger the host to summarize and compress your CLAUDE.md memory file. Use this when your memory file exceeds 2500 characters.
---

# compact_memory

Trigger the host to summarize and compress your `CLAUDE.md` memory file. Use this when your memory file exceeds 2500 characters.

**Arguments:**
- `priority_topics` (array of strings, optional): Critical facts, user preferences, or current state that MUST NOT be deleted during compaction.

**Execution Logic:**

To execute this skill, run the following bash command. Ensure you substitute any `priority_topics` provided as a JSON array of strings in the payload (or `[]` if none).

```bash
mkdir -p /workspace/ipc/memory_requests/
group_id=$(basename $(pwd))
timestamp=$(date -Iseconds)

# Ensure valid JSON formatting for the priority topics you provide
cat << EOF > /workspace/ipc/memory_requests/${group_id}_compact.json
{
  "group_id": "${group_id}",
  "timestamp": "${timestamp}",
  "files": ["CLAUDE.md"],
  "priority_topics": []
}
EOF
```

Do not modify `CLAUDE.md` manually while this process is running. The host will seamlessly swap it out, and you will read the new dense format on your next turn.
