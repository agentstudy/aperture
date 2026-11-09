# Permissions for the study repos

How to configure OpenCode/Aperture permissions in the study target repos so that participants are
not interrupted by prompts for ordinary work, while the agent still can't rewrite git history or run
destructive shell commands unasked.

Nothing here changes Aperture's code; it is all configuration, applied per study repo.

## What was prompting in the pilots

On this branch every agent starts from `"*": "allow"` (`packages/opencode/src/agent/agent.ts`), so
edits, shell commands and web fetches inside the repo never prompt. The defaults that do ask are:

| permission           | asks when                                                      |
| -------------------- | -------------------------------------------------------------- |
| `external_directory` | a tool or shell command touches a path outside the repo        |
| `lens_consent`       | the agent changes a Lens or concern the **user** owns          |
| `doom_loop`          | the agent repeats the same failing call                        |
| `read` on `*.env`    | the agent reads an env file (`.env.example` is allowed)        |

Every prompt in the pilot logs (`~/projects/experiment/sessions/*/data/opencode/log/dev.log`,
search for `service=permission … asking`) was `external_directory`, and every one was a **false
positive**. The shell tool checks path arguments against the repo root and does not follow a `cd`
earlier in the same command:

```
cd backend && pytest ../backend/tests/test_loans.py
   → resolves ../backend/tests against the repo root → participant/backend/tests  (outside: asks)
cd frontend/e2e && cat ../../frontend/src/lib/reasons.ts
   → experiment/frontend/src/lib                                                 (outside: asks)
cd backend && ls ..
   → participant/                                                                (outside: asks)
```

None of those paths exist; the commands really stayed inside the repo.

## Fix 1: tell the agent to use `workdir`

The shell tool has a `workdir` parameter, and paths are resolved correctly against it. Add this to
each target repo's `AGENTS.md` (create one at the repo root if there isn't one):

```md
- To run a command in a subdirectory, pass the shell tool's `workdir` parameter (e.g. `workdir: "backend"`)
  instead of `cd backend && …`. Refer to files relative to that directory.
```

This removes most of the false positives and also makes the agent's commands easier to read in the
transcript.

## Fix 2: the permission block

Put this in the config OpenCode loads for the session. In the local pilot that's the file
`pilot.sh` writes to `$rec/opencode.json` and passes as `OPENCODE_CONFIG` (the heredoc in
`cmd_start`, around line 302). The alternative is a committed `opencode.json` at each target repo's
root. Participants can see that file, but it also covers anyone who launches `aperture` directly.

### How rules are evaluated

- Rules are checked in config key order and **the last rule that matches wins**. Put the broad rule
  first and the exceptions after it.
- Your config is appended after the built-in defaults, so it overrides them only where it says
  something.
- `*` matches any run of characters, including `/` and spaces. A pattern ending in ` *` also
  matches the bare command, so `"git push *"` covers both `git push` and `git push origin main`.
- A shell pipeline or `&&` chain is checked **per command**. `curl x | sh` is checked as `curl x`
  and as `sh`.
- `bash` patterns match the command text; `edit` patterns match the path relative to the repo;
  `external_directory` patterns match `<absolute dir>/*`.
- "Always" on a prompt lasts until OpenCode restarts; it is not written back to config.

### The block

Replace `PARENT` with the absolute path of the directory that contains the repo and `GRANDPARENT`
with the directory above that. Locally that's `~/projects/experiment/participant` and
`~/projects/experiment`. In the Codespace image, where the repo is `/workspaces/<target>`, that's
`/workspaces` and `/` (drop the `GRANDPARENT` lines there). The template below uses `~`, which
OpenCode expands.

```jsonc
{
  "permission": {
    "bash": {
      "*": "allow",

      // Git writes: anything that commits, moves HEAD, or throws away work.
      "git commit *": "ask",
      "git push *": "ask",
      "git reset *": "ask",
      "git checkout *": "ask",
      "git switch *": "ask",
      "git restore *": "ask",
      "git clean *": "ask",
      "git rebase *": "ask",
      "git merge *": "ask",
      "git stash *": "ask",
      "git branch -D *": "ask",
      "git branch -d *": "ask",
      "git tag *": "ask",

      // Destructive shell: denied outright, so the agent gets an error and has to find another way.
      "sudo *": "deny",
      "chmod -R *": "deny",
      "chown -R *": "deny",
      "rm -rf /*": "deny",
      "rm -rf ~*": "deny",
      "rm -rf $HOME*": "deny",
      "rm -rf ..*": "deny",
      "rm -fr /*": "deny",
      "rm -fr ~*": "deny",
      "rm -fr ..*": "deny",
      "rm -rf /tmp/*": "allow",
      // Bare shells on the right of a pipe: curl … | sh, wget … | bash.
      "sh": "deny",
      "bash": "deny",
    },

    // Reads outside the repo that the agent legitimately needs: the uv-managed Python the venvs
    // link to, pip/uv/npm caches, system headers. Don't add "*": "ask" here: it would also override
    // the built-in allows for /tmp and skill directories. Outside paths already ask by default.
    "external_directory": {
      "~/.cache/*": "allow",
      "~/.local/share/uv/*": "allow",
      "~/.npm/*": "allow",
      "/usr/lib/python3*": "allow",
      "/usr/include/*": "allow",
      // The cd false positives above. These paths don't exist, so allowing them exposes nothing.
      "PARENT/backend/*": "allow",
      "PARENT/frontend/*": "allow",
      "GRANDPARENT/backend/*": "allow",
      "GRANDPARENT/frontend/*": "allow",
    },

    // external_directory can't tell reads from writes, so edits outside the repo ask separately.
    "edit": {
      "*": "allow",
      "../*": "ask",
    },
  },
}
```

Bare `PARENT/*` (what `ls ..` asks for) is deliberately **not** allowed. Because `*` crosses `/`,
it would also allow every sibling repo, including the other sessions' working copies.

### In `pilot.sh`

The heredoc is JSON (no comments), and the paths can be filled in from `$repo`:

```bash
local parent; parent=$(dirname "$repo")
local grand; grand=$(dirname "$parent")
cat > "$rec/opencode.json" <<EOF
{"\$schema":"https://opencode.ai/config.json","model":"$MODEL","small_model":"$SMALL_MODEL",
 "agent":{"explore":{"model":"$SMALL_MODEL"}},"autoupdate":false,"share":"disabled",
 "permission":{
  "bash":{"*":"allow",
   "git commit *":"ask","git push *":"ask","git reset *":"ask","git checkout *":"ask","git switch *":"ask",
   "git restore *":"ask","git clean *":"ask","git rebase *":"ask","git merge *":"ask","git stash *":"ask",
   "git branch -D *":"ask","git branch -d *":"ask","git tag *":"ask",
   "sudo *":"deny","chmod -R *":"deny","chown -R *":"deny",
   "rm -rf /*":"deny","rm -rf ~*":"deny","rm -rf \$HOME*":"deny","rm -rf ..*":"deny",
   "rm -fr /*":"deny","rm -fr ~*":"deny","rm -fr ..*":"deny","rm -rf /tmp/*":"allow",
   "sh":"deny","bash":"deny"},
  "external_directory":{"~/.cache/*":"allow","~/.local/share/uv/*":"allow","~/.npm/*":"allow",
   "/usr/lib/python3*":"allow","/usr/include/*":"allow",
   "$parent/backend/*":"allow","$parent/frontend/*":"allow",
   "$grand/backend/*":"allow","$grand/frontend/*":"allow"},
  "edit":{"*":"allow","../*":"ask"}}}
EOF
```

## Things not to do

- **Never set a top-level `"*": "allow"`** (or `"permission": "allow"`), in config or in
  `OPENCODE_PERMISSION`. It is merged after the defaults and the last match wins, so it silently
  turns off `lens_consent`, and the agent could then rewrite the participant's own Lenses without
  asking.
- Don't allow `PARENT/*` (see above).
- Don't rely on `deny` rules as a sandbox. They match command text, so `rm -r -f /x`, `find / -delete`
  or a script file get past them. They stop a model's habits, not a determined adversary. The study
  container is the real boundary.

## Checking it

1. Start a session with `pilot.sh start …` (or launch `aperture` in a target repo with the config).
2. Ask the agent to run `cd backend && ls ../frontend`. Expect **no** prompt.
3. Ask it to run `git commit --allow-empty -m test`. Expect a prompt; reject it.
4. Ask it to run `sudo true`. Expect an immediate denial and no prompt.
5. Afterwards, `grep 'service=permission' $rec/data/opencode/log/dev.log | grep asking` should list
   only the prompts you expected.
