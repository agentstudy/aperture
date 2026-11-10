// Study logger: coarse, timestamped editor events, identical in both conditions.
//
// Writes <record>/vscode-events.jsonl, where <record> is /workspaces/.study/<repo> (as in
// study-lib.sh). One JSON object per line: {ts, ev, ...}. No file contents, no line ranges,
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
// It also does the session's first-start layout once (marker <record>/.layout-done): select the
// condition's file view, move the panel to the right, and start the tool in a terminal there.
// Every handler is wrapped: logging must never disturb the participant.
"use strict"
const vscode = require("vscode")
const fs = require("fs")
const path = require("path")

let record, eventsFile, sideFile, root
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
function takeDef() {
  const d = pendingDef
  pendingDef = undefined
  return d && now() - d.t < 3000 ? d : undefined
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
async function firstStartLayout() {
  const marker = path.join(record, ".layout-done")
  if (fs.existsSync(marker)) return
  fs.writeFileSync(marker, new Date().toISOString())
  const tool = readTool()
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
  try {
    await vscode.commands.executeCommand("workbench.action.positionPanelRight")
  } catch {}
  const term = vscode.window.createTerminal({ name: tool === "aperture" ? "Aperture" : "OpenCode", cwd: root })
  term.show(false)
  term.sendText(tool)
  log("layout", { tool, view, viewShown: shown })
}

// ---- activation ----------------------------------------------------------------------------------
function activate(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  if (!folder) return
  root = folder.uri.fsPath
  record = path.join(process.env.STUDY_RECORD_BASE || "/workspaces/.study", path.basename(root))
  try {
    fs.mkdirSync(record, { recursive: true })
  } catch {}
  eventsFile = path.join(record, "vscode-events.jsonl")
  sideFile = path.join(record, ".last-side")
  const ext = context.extension && context.extension.packageJSON
  log("logger.activate", { vscode: vscode.version, logger: ext && ext.version, tool: readTool() })
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
        if (e.closed.length) knownTabs = tabPaths()
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
        safe((e) => log("terminal.command", { terminal: e.terminal.name, cmd: e.execution.commandLine.value })),
      ),
    )
    sub(
      vscode.window.onDidEndTerminalShellExecution(
        safe((e) =>
          log("terminal.command.end", { terminal: e.terminal.name, cmd: e.execution.commandLine.value, exit: e.exitCode }),
        ),
      ),
    )
  }

  // Window focus: leaving VS Code usually means the app tab or the notepad.
  let focused = vscode.window.state.focused
  sub(
    vscode.window.onDidChangeWindowState(
      safe((s) => {
        if (s.focused === focused) return
        focused = s.focused
        log(s.focused ? "window.focus" : "window.blur")
        if (!s.focused) writeSide("away")
      }),
    ),
  )

  firstStartLayout().catch((e) => log("logger.error", { where: "layout", message: String(e) }))
}

module.exports = { activate, deactivate() {} }
