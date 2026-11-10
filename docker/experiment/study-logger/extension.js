// Study logger: coarse, timestamped editor events, identical in both conditions.
//
// Writes <record>/vscode-events.jsonl, where <record> is /workspaces/.study/<repo>/<phase> and phase
// is warmup or main (as in study-lib.sh). When study-next writes <repo dir>/switched, the logger moves
// to the main-task record and resets the window for the main task (see switchToMain). When study-submit
// writes <repo dir>/submit-done, it closes the editors and the tool terminal and stops logging. One JSON object per line: {ts, ev, ...}. No file contents, no line ranges,
// no keystrokes. The events:
//   logger.activate          every window load (so reloads are visible)
//   file.open   {path, tab: new|existing, via?: definition}
//   diff.open   {path, source: scm|<scheme>}
//   definition  {file, symbol}       F12 / Ctrl+click that jumped (Peek and Ctrl+hover are not logged)
//   references  {file, symbol}
//   symbol.search                    Ctrl+T, once per burst
//   edit        {path}               a participant edit, once per file per 30 s (agent edits are in its own log)
//   terminal.command {terminal, cmd} / terminal.command.end {terminal, cmd, exit}
//   window.focus / window.blur
//   code.visit  {path}               first editor interaction after the participant was in the chat or away
// chat.visit comes from study-pty, which shares the <record>/.last-side file with this logger.
//
// It also does the codespace's first-start layout once (marker <repo dir>/.layout-done): select the
// condition's file view, move the panel to the right, and start the tool in a terminal there.
// Every handler is wrapped: logging must never disturb the participant.
"use strict"
const vscode = require("vscode")
const fs = require("fs")
const path = require("path")

let repoDir, record, eventsFile, sideFile, root
const now = () => Date.now()

function log(ev, fields) {
  try {
    fs.appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), ev, ...fields }) + "\n")
  } catch {}
}

function safe(fn) {
  return (...a) => {
    try {
      return fn(...a)
    } catch (e) {
      log("logger.error", { message: String(e && e.message ? e.message : e) })
    }
  }
}

// Shell integration reports the command as drawn on screen: line wraps become newlines, and after a
// reload it can include the whole scrollback.
const cleanCmd = (s) => String(s || "").replace(/[\r\n]/g, "").slice(0, 200)
const rel = (uri) => (root && uri.fsPath.startsWith(root + path.sep) ? path.relative(root, uri.fsPath) : uri.fsPath)
const inRepo = (uri) => uri && uri.scheme === "file" && root && uri.fsPath.startsWith(root + path.sep)

// ---- visits: which side the participant last interacted with --------------------------------
function readSide() {
  try {
    return fs.readFileSync(sideFile, "utf8").split(" ")[0]
  } catch {
    return ""
  }
}
function writeSide(side) {
  try {
    fs.writeFileSync(sideFile, `${side} ${now()}`)
  } catch {}
}
let lastCodeCheck = 0
let lastCodeFile = ""
function codeActivity(uri) {
  if (!inRepo(uri)) return
  const p = rel(uri)
  const t = now()
  // Throttled: reading the side file on every cursor move is pointless.
  if (t - lastCodeCheck < 1000 && p === lastCodeFile) return
  lastCodeCheck = t
  lastCodeFile = p
  if (readSide() !== "code") {
    log("code.visit", { path: p })
    writeSide("code")
  }
}

// ---- definition: only lookups that actually jumped ------------------------------------------
let pendingDef // {t, file, symbol}
let lastRefT = 0
function takeDef() {
  const d = pendingDef
  pendingDef = undefined
  return d && now() - d.t < 3000 && now() - lastRefT > 1000 ? d : undefined
}
function symbolAt(doc, pos) {
  const r = doc.getWordRangeAtPosition(pos)
  return r ? doc.getText(r).slice(0, 80) : ""
}

// ---- first-start layout ------------------------------------------------------------------------
function readTool() {
  try {
    const m = /^TOOL=(\w+)/m.exec(fs.readFileSync("/opt/tool/tool.env", "utf8"))
    return m ? m[1] : "opencode"
  } catch {
    return "opencode"
  }
}
// Codespaces runs the postAttach hook in its own terminal ("Codespaces: ..."), which would otherwise
// cover ours. Resolved when that hook ends, or after a timeout if it never shows up.
let hookDone
const hookFinished = new Promise((r) => (hookDone = r))
const isHook = (t) => /^Codespaces:/.test(t.name)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PANEL_WIDEN_STEPS = 7 // each step is a fixed number of pixels; tune for the study screens

async function firstStartLayout() {
  const marker = path.join(repoDir, ".layout-done")
  if (fs.existsSync(marker)) return
  fs.writeFileSync(marker, new Date().toISOString())
  const tool = readTool()
  // A terminal created before the Python extensions finish contributing their environment shows a
  // "relaunch terminal" warning, so start ours after they are active and after the hook is done.
  const ready = ["ms-python.python", "ms-python.debugpy"].map((id) => {
    const e = vscode.extensions.getExtension(id)
    return e ? Promise.resolve(e.activate()).catch(() => {}) : Promise.resolve()
  })
  // The hook may also have finished before this window's logger started: study-attach writes "done".
  const started = now()
  const traceDone = (async () => {
    for (let i = 0; i < 90; i++) {
      try {
        const f = path.join(require("os").homedir(), ".study-attach-path")
        if (/^done /m.test(fs.readFileSync(f, "utf8")) && fs.statSync(f).mtimeMs > started - 120000) return
      } catch {}
      await sleep(500)
    }
  })()
  await Promise.race([Promise.all([...ready, Promise.race([hookFinished, traceDone])]), sleep(45000)])
  const view = tool === "aperture" ? "workbench.view.extension.aperture" : "workbench.view.explorer"
  // Aperture's view container exists only once its extension has registered; give it a while.
  let shown = false
  for (let i = 0; i < 20 && !shown; i++) {
    try {
      await vscode.commands.executeCommand(view)
      shown = true
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  for (const t of vscode.window.terminals) if (isHook(t)) t.dispose()
  for (const cmd of ["workbench.action.closeAuxiliaryBar", "workbench.action.positionPanelRight"]) {
    try {
      await vscode.commands.executeCommand(cmd)
    } catch {}
  }
  const term = toolTerminal(tool)
  await sleep(800)
  for (let i = 0; i < PANEL_WIDEN_STEPS; i++) {
    try {
      await vscode.commands.executeCommand("workbench.action.increaseViewWidth")
    } catch {}
  }
  term.show(false)
  log("layout", { tool, view, viewShown: shown })
}

// The tool is the terminal's own process, so nothing is typed into a shell (and nothing can be typed
// into the tool by other extensions). When it exits, the terminal becomes a normal shell.
const toolName = (tool) => (tool === "aperture" ? "Aperture" : "OpenCode")
function toolTerminal(tool) {
  const term = vscode.window.createTerminal({
    name: toolName(tool),
    cwd: root,
    shellPath: "/bin/bash",
    shellArgs: ["-lc", `${tool}; exec bash -l`],
  })
  term.show(false)
  return term
}

// ---- phases ----------------------------------------------------------------------------------------
function readPhase() {
  try {
    const p = fs.readFileSync(path.join(repoDir, "phase"), "utf8").trim()
    if (p === "warmup" || p === "main" || p === "submitted") return p
  } catch {}
  try {
    // study-start normally writes the phase file before any window attaches; this is the fallback.
    return /-warmup\s*$/.test(fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8")) ? "warmup" : "main"
  } catch {
    return "main"
  }
}
function usePhase(phase) {
  record = path.join(repoDir, phase)
  try {
    fs.mkdirSync(record, { recursive: true })
  } catch {}
  eventsFile = path.join(record, "vscode-events.jsonl")
  sideFile = path.join(record, ".last-side")
}
// study-next has switched the repo to the main task. Its terminal has finished by now (switched is
// its last write), so the old tool terminals can go.
let switched = false
async function switchToMain() {
  if (switched) return
  switched = true
  usePhase("main")
  const tool = readTool()
  log("phase", { phase: "main", tool })
  for (const t of vscode.window.terminals) if (t.name === toolName(tool)) t.dispose()
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "TASK-README.md")), { preview: false })
  } catch (e) {
    log("logger.error", { where: "switch", message: String(e) })
  }
  toolTerminal(tool)
}

// study-submit has pushed the work and reset the tree. Take everything that showed the work or the
// chat off the screen: the tool terminal (its scrollback is the chat) and every editor. Logging stops.
let submitted = false
async function clearAfterSubmit() {
  if (submitted) return
  submitted = true
  eventsFile = sideFile = null // the records were moved away with the submission
  for (const t of vscode.window.terminals) if (t.name === toolName(readTool())) t.dispose()
  await vscode.commands.executeCommand("workbench.action.closeAllEditors")
}

// ---- activation ----------------------------------------------------------------------------------
function activate(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  if (!folder) return
  root = folder.uri.fsPath
  repoDir = path.join(process.env.STUDY_RECORD_BASE || "/workspaces/.study", path.basename(root))
  const startPhase = readPhase()
  if (startPhase === "submitted") return // nothing left to lay out or log
  usePhase(startPhase)
  const ext = context.extension && context.extension.packageJSON
  log("logger.activate", { vscode: vscode.version, logger: ext && ext.version, tool: readTool(), phase: startPhase })
  if (startPhase === "warmup") {
    // Polled rather than fs.watch: the marker's directory may not exist yet, and 2 s is plenty.
    const marker = path.join(repoDir, "switched")
    const timer = setInterval(
      safe(() => {
        if (fs.existsSync(marker)) {
          clearInterval(timer)
          switchToMain().catch((e) => log("logger.error", { where: "switch", message: String(e) }))
        }
      }),
      2000,
    )
    context.subscriptions.push({ dispose: () => clearInterval(timer) })
  }
  {
    const marker = path.join(repoDir, "submit-done")
    const timer = setInterval(
      safe(() => {
        if (fs.existsSync(marker)) {
          clearInterval(timer)
          clearAfterSubmit().catch(() => {})
        }
      }),
      2000,
    )
    context.subscriptions.push({ dispose: () => clearInterval(timer) })
  }
  const sub = (d) => context.subscriptions.push(d)

  // file.open / code.visit. tab=new when the file had no tab before this switch.
  let knownTabs = new Set()
  const tabPaths = () => {
    const s = new Set()
    for (const g of vscode.window.tabGroups.all)
      for (const t of g.tabs) if (t.input instanceof vscode.TabInputText) s.add(t.input.uri.fsPath)
    return s
  }
  knownTabs = tabPaths()
  sub(
    vscode.window.onDidChangeActiveTextEditor(
      safe((ed) => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab
        const isDiff = active && active.input instanceof vscode.TabInputTextDiff
        if (ed && inRepo(ed.document.uri) && !isDiff) {
          const d = takeDef()
          if (d) log("definition", { file: d.file, symbol: d.symbol })
          log("file.open", {
            path: rel(ed.document.uri),
            tab: knownTabs.has(ed.document.uri.fsPath) ? "existing" : "new",
            ...(d ? { via: "definition" } : {}),
          })
          codeActivity(ed.document.uri)
        }
        knownTabs = tabPaths()
      }),
    ),
  )
  sub(
    vscode.window.tabGroups.onDidChangeTabs(
      safe((e) => {
        for (const t of e.opened) {
          if (t.input instanceof vscode.TabInputTextDiff) {
            const o = t.input.original
            log("diff.open", { path: rel(t.input.modified), source: o.scheme === "git" ? "scm" : o.scheme })
          }
        }
        for (const t of e.closed) if (t.input instanceof vscode.TabInputText) knownTabs.delete(t.input.uri.fsPath)
      }),
    ),
  )

  // Selection and scrolling count as being in the code. A same-file F12 jump shows up as a
  // selection change made by a command, which is what resolves a pending definition here.
  let lastReload = 0
  sub(
    vscode.window.onDidChangeTextEditorSelection(
      safe((e) => {
        if (e.kind === vscode.TextEditorSelectionChangeKind.Command) {
          const d = takeDef()
          if (d) log("definition", { file: d.file, symbol: d.symbol })
        }
        if (e.kind !== undefined) codeActivity(e.textEditor.document.uri)
      }),
    ),
  )
  sub(
    vscode.window.onDidChangeTextEditorVisibleRanges(
      safe((e) => {
        // The agent rewriting an open file can shift what is visible; that is not the participant.
        if (now() - lastReload > 750) codeActivity(e.textEditor.document.uri)
      }),
    ),
  )

  // edit: participant edits leave the document dirty; the agent's disk writes reload it clean.
  const lastEdit = new Map()
  sub(
    vscode.workspace.onDidChangeTextDocument(
      safe((e) => {
        if (!inRepo(e.document.uri) || e.contentChanges.length === 0) return
        if (!e.document.isDirty) {
          lastReload = now()
          return
        }
        const p = rel(e.document.uri)
        if (now() - (lastEdit.get(p) || 0) > 30000) log("edit", { path: p })
        lastEdit.set(p, now())
        codeActivity(e.document.uri)
      }),
    ),
  )

  // Code intelligence. These providers return nothing: VS Code merges every provider's results,
  // so Pylance and the TypeScript server still answer exactly as before.
  const files = { scheme: "file" }
  sub(
    vscode.languages.registerDefinitionProvider(files, {
      provideDefinition: safe((doc, pos) => {
        pendingDef = { t: now(), file: rel(doc.uri), symbol: symbolAt(doc, pos) }
        return undefined
      }),
    }),
  )
  let lastRef = { t: 0, key: "" }
  sub(
    vscode.languages.registerReferenceProvider(files, {
      provideReferences: safe((doc, pos) => {
        const key = `${doc.uri.fsPath}:${pos.line}:${pos.character}`
        if (now() - lastRef.t > 2000 || key !== lastRef.key)
          log("references", { file: rel(doc.uri), symbol: symbolAt(doc, pos) })
        lastRef = { t: now(), key }
        lastRefT = now()
        return undefined
      }),
    }),
  )
  let lastSym = 0
  sub(
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols: safe(() => {
        if (now() - lastSym > 5000) log("symbol.search")
        lastSym = now()
        return []
      }),
    }),
  )

  // Commands the participant runs in a terminal (needs shell integration, which bash has by default).
  if (vscode.window.onDidStartTerminalShellExecution) {
    sub(
      vscode.window.onDidStartTerminalShellExecution(
        safe((e) => log("terminal.command", { terminal: e.terminal.name, cmd: cleanCmd(e.execution.commandLine.value) })),
      ),
    )
    sub(
      vscode.window.onDidEndTerminalShellExecution(
        safe((e) => {
          log("terminal.command.end", { terminal: e.terminal.name, cmd: cleanCmd(e.execution.commandLine.value), exit: e.exitCode })
          if (isHook(e.terminal)) hookDone()
        }),
      ),
    )
  }

  // Window focus: leaving VS Code usually means the app tab or the notepad.
  // A blur counts only if it lasts a second: the browser flickers focus when moving between frames.
  let logged = vscode.window.state.focused
  let blurTimer
  sub(
    vscode.window.onDidChangeWindowState(
      safe((s) => {
        clearTimeout(blurTimer)
        if (s.focused) {
          if (!logged) log("window.focus")
          logged = true
          return
        }
        blurTimer = setTimeout(
          safe(() => {
            if (vscode.window.state.focused || !logged) return
            logged = false
            log("window.blur")
            writeSide("away")
          }),
          1000,
        )
      }),
    ),
  )

  firstStartLayout().catch((e) => log("logger.error", { where: "layout", message: String(e) }))
}

module.exports = { activate, deactivate() {} }
