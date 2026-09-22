# Hooks

Empty on purpose: a hook referencing a script that doesn't exist yet blocks every Bash/Edit/Write
call in the project (this happened once already during setup — see session history). Add a hook
script here and wire it into `../settings.json` only after the underlying tool exists and has been
run manually at least once, e.g. once `apps/web` has `prettier`/`eslint` installed:

```json
"hooks": {
  "PostToolUse": [{
    "matcher": "Write|Edit",
    "hooks": [{ "type": "command", "command": "jq -r '.tool_input.file_path' | { read -r f; npx prettier --write \"$f\" 2>/dev/null || true; }" }]
  }]
}
```

Verify with the `update-config` skill's pipe-test step before adding, not after.
