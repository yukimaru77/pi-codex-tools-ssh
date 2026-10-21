# pi-codex-tools

A Pi extension package that exposes Codex-style tool names and argument shapes:

- `shell`
- `shell_command`
- `local_shell`
- `exec_command`
- `write_stdin`
- `apply_patch`
- `view_image`

The implementation is local to Pi and intentionally preserves Codex parameter names where Pi custom tools can represent them.

## Local additions

This private copy retains the SSH-routing hooks added earlier and now automatically
selects workspace tools by the selected model's **ID or display name**, independently
of its provider:

| Model | Enabled | Disabled |
|---|---|---|
| GPT family (case-insensitive) | All seven Codex tools above | `bash`, `edit`, `write` |
| Other models, or no model | `bash`, `edit`, `write` | All seven Codex tools |

`read` stays enabled in both modes. Other active tools, including Web/image tools,
SSH controls, monitors, goals and codemode, are preserved. Optional built-in
`grep/find/ls/powershell` selections are not changed. GPT matching accepts `gpt-6`,
`GPT 6`, `GPT6` and `openai/gpt-6`, but not `mygptproxy`. OpenAI `o3` and a Codex
model without GPT in its ID/name use standard tools, as requested.

Selection runs at session start/reload, `model_select` and `before_agent_start`.
It uses Pi's public `setActiveTools()` API. These direct-exposure tools are removed
from both model declarations and the callable tools available to codemode when
inactive. If essential Codex tools failed to register, GPT falls back to registered
standard tools. Unrelated disabled tools stay disabled.

The extension remains loaded in both modes; its **tool exposure** is switched,
not its process lifetime. Changing model does not terminate existing exec sessions
or change SSH targets. A non-GPT model cannot use `write_stdin`; switch back to GPT
to interact with an existing exec session. Normal extension shutdown still cleans
up its local processes.

This policy owns the selection of `read`, `bash/edit/write` and the seven Codex
tools; manual changes to these names are reconciled before the next user turn.
Explicit CLI tool exclusions remain enforced by Pi. A provider's hidden/internal
per-request model routing is not classified: the selected Pi model is authoritative.

The footer shows `tools: Codex (GPT)` or `tools: standard` where a UI is available.
Use `/reload` once after installation; later ordinary model changes need no reload.
The shared `~/.pi/agent/APPEND_SYSTEM.md` now has tool-availability-conditional guidance
instead of always requiring Codex tools. No authentication/model settings or DSH
configuration are changed.

## Local verification

Tested with Pi 1.1.0 / Node 26 on this machine, without any provider network calls:

```sh
node --test tests/model-tool-selection.test.mjs  # 18 cases
node tests/sdk-smoke.mjs                       # real Pi loader + session
PI_TEST_WITH_SSH=1 node tests/sdk-smoke.mjs     # with installed SSH extension
/Users/nonaka/tasks/dsh-pi-compat/node_modules/.bin/tsc -p tests/tsconfig.json
```

SDK tests use a temporary agent directory, synthetic provider credentials, an
in-memory session and a fetch trap. They verify model changes in both directions,
name/ID matching, reload in each mode, callable-tool isolation, local Codex patch/exec
and standard write/edit/bash operations, and the preserved SSH capability protocol.
They do not establish a real SSH connection or call a model.

Backup before this change: `backups/before-model-routing-20261018/` (original entry,
Pi settings and appended instructions). For rollback, restore the original entry
and disable this package's extensions in Pi settings; compare settings before
restoring a whole backup if subsequent edits have been made. The new helper is inert
without its import. Reload Pi after rollback.
