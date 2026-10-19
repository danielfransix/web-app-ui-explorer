import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"
import { canonicalDirectory } from "./project-identity"

const BEGIN = "# BEGIN UI Explorer project MCP"
const END = "# END UI Explorer project MCP"
const localCli = "node_modules/@danielfransix/web-app-ui-explorer/dist/node/cli.js"

export type McpInstallOptions = { root: string; client: "vscode" | "codex"; baseUrl?: string; route?: string }

/** Project-local only. Never reads or writes the person's user-level MCP configuration. */
export function installProjectMcp(options: McpInstallOptions) {
  if (options.client !== "vscode" && options.client !== "codex") throw new Error("Choose client vscode or codex; MCP setup is project-local only.")
  const root = fs.realpathSync(path.resolve(options.root))
  if (canonicalDirectory(root) === canonicalDirectory(os.homedir()) || !fs.existsSync(path.join(root, "package.json")))
    throw new Error("Run MCP installation in an app project with a package.json, not your home directory.")
  const cli = path.join(root, localCli)
  if (!fs.existsSync(cli)) throw new Error("Install @danielfransix/web-app-ui-explorer in this project's devDependencies first. A global package cannot provide project-local MCP setup.")
  if (options.baseUrl) {
    const url = new URL(options.baseUrl)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Use an http(s) app URL without credentials, query or fragment.")
  }
  if (options.route && (!options.route.startsWith("/") || /[?#]/.test(options.route))) throw new Error("The Explorer route must be an absolute URL path without query or fragment.")
  const directory = path.join(root, options.client === "vscode" ? ".vscode" : ".codex")
  const file = path.join(directory, options.client === "vscode" ? "mcp.json" : "config.toml")
  if (fs.existsSync(directory) && canonicalDirectory(directory) !== (process.platform === "win32" ? directory.toLowerCase() : directory))
    throw new Error("MCP configuration directory must not redirect through a symlink. No configuration was changed.")
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("MCP configuration file must not be a symlink.")
  const launchRoot = options.client === "vscode" ? "${workspaceFolder}" : root
  const launchCli = options.client === "vscode" ? "${workspaceFolder}/" + localCli : cli
  const args = [launchCli, "mcp", "--root", launchRoot,
    ...(options.baseUrl ? ["--base-url", options.baseUrl] : []), ...(options.route ? ["--route", options.route] : [])]
  const command = options.client === "vscode" ? "node" : process.execPath
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  let next: string
  if (options.client === "vscode") {
    const errors: ParseError[] = []
    const config = parse(previous || "{}", errors, { allowTrailingComma: true })
    if (errors.length || !config || typeof config !== "object" || Array.isArray(config) || (Object.hasOwn(config, "servers") && (!config.servers || typeof config.servers !== "object" || Array.isArray(config.servers))))
      throw new Error("Invalid .vscode/mcp.json. Fix it before installing; no configuration was changed.")
    const entry = { type: "stdio", command, args, cwd: launchRoot }
    const existing = config.servers?.["ui-explorer"]
    if (Object.hasOwn(config.servers ?? {}, "ui-explorer") && !isDeepStrictEqual(existing, entry))
      throw new Error("An existing ui-explorer MCP entry has different settings. Review and remove that entry before rerunning installation; other servers were preserved.")
    next = existing ? previous : applyEdits(previous || "{}\n", modify(previous || "{}\n", ["servers", "ui-explorer"], entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  } else {
    // Parse first, then replace only our exact marked block, preserving comments and other tables.
    parseToml(previous)
    const starts = [...previous.matchAll(/^# BEGIN UI Explorer project MCP\r?$/gm)]
    const ends = [...previous.matchAll(/^# END UI Explorer project MCP\r?$/gm)]
    if (starts.length !== ends.length || starts.length > 1 || (starts.length && starts[0].index! >= ends[0].index!))
      throw new Error("Malformed UI Explorer MCP markers in .codex/config.toml. No configuration was changed.")
    const remainder = starts.length ? previous.slice(0, starts[0].index) + previous.slice(ends[0].index! + ends[0][0].length) : previous
    const config = parseToml(remainder)
    const servers = config.mcp_servers as Record<string, unknown> | undefined
    if (servers && "ui-explorer" in servers) throw new Error("An unmarked ui-explorer MCP entry already exists. Review and remove it before rerunning installation; no configuration was changed.")
    const block = `${BEGIN}\n[mcp_servers.ui-explorer]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ncwd = ${JSON.stringify(root)}\n${END}`
    next = starts.length ? previous.slice(0, starts[0].index) + block + previous.slice(ends[0].index! + ends[0][0].length)
      : `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${previous ? "\n" : ""}${block}\n`
    // A person may have added fields inside our markers. Never silently discard their settings.
    if (starts.length) {
      const owned = parseToml(previous.slice(starts[0].index, ends[0].index))
      const ownedServers = owned.mcp_servers as Record<string, unknown> | undefined
      if (Object.keys(owned).some(key => key !== "mcp_servers") || !ownedServers || Object.keys(ownedServers).some(key => key !== "ui-explorer"))
        throw new Error("The managed MCP block contains unrelated settings. Move them outside its markers before reinstalling; no configuration was changed.")
      const current = parseToml(previous).mcp_servers as Record<string, unknown>
      const existing = current?.["ui-explorer"] as Record<string, unknown> | undefined
      if (!existing || Object.keys(existing).some(key => !["command", "args", "cwd"].includes(key)))
        throw new Error("The managed ui-explorer entry contains custom settings. Review it before reinstalling; no configuration was changed.")
    }
    parseToml(next)
  }
  if (next !== previous) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(file, next, "utf8")
  }
  return { file, changed: next !== previous, root, command, args }
}
