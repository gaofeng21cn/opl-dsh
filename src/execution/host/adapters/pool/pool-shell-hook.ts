/**
 * Suite-owned pool settings: the only supported way to pin the tool interpreter.
 *
 * Evidence, all from the official Poolside Agent CLI v1.0.16 Windows package
 * (`pool --version` prints `1.0.16`; archive
 * `https://downloads.poolside.ai/pool/v1.0.16/pool-windows-amd64.tar.gz`,
 * SHA256 `3e324f1a4b5855ba5363232c06461ec9d6d2ae1a341c827221e79779f8f2bc6f`
 * equal to that release's `checksums.txt`), its official documentation at
 * `https://docs.poolside.ai/settings-file-reference`, `.../hooks` and
 * `.../permissions`, and the strings inside the shipped binary:
 *
 *  - The shell tool takes the interpreter per call. `ShellRunArgs` in
 *    `github.com/poolsideai/forge/pkg/agent/llmtools/shell` declares
 *    `shell`, `shell_args` ("Arguments to pass to the shell binary"),
 *    `shell_id`, `mode`, `cwd` and `env`. There is no `pool.shell`,
 *    `default_shell` or `shell_path` key in the settings reference, and the
 *    binary carries no such environment variable either, so a *global* default
 *    interpreter is not part of the public interface.
 *  - `PreToolUse` hooks may rewrite tool arguments with
 *    `hook_specific_output.updated_input`, they run "after argument validation
 *    and before the approval prompt", and "a rewritten call is approved on its
 *    rewritten arguments". Hook lists combine from the least specific settings
 *    level to the most specific one, each hook seeing the previous hook's
 *    rewrite, and `pool acp --settings` is documented as the most specific
 *    level. Passing the pinned shell through a `--settings` hook is therefore
 *    both the only supported pin and the last word against a project-level
 *    hook.
 *  - Hooks fail open by official design ("Hooks fail open and are not a
 *    security boundary"). A hook that cannot start would leave the model's own
 *    `shell` in place, which on Windows is PowerShell. The adapter therefore
 *    executes this exact hook script before every launch
 *    (`verifyPoolShellHook`) and refuses to start the CLI when it does not
 *    return the pinned decision, and the hook blocks the call itself when the
 *    pinned executable is missing instead of letting another interpreter run.
 *
 * These modules stay free of imports so the shipped hook file, the settings
 * bytes, and an isolated probe of the real CLI all come from one definition.
 */

/** Harness identity the OPL catalog binds this adapter to. */
export const POOL_HARNESS = 'pool'

/** Hook name. A named hook replaces an earlier same-named hook when levels merge. */
export const POOL_SHELL_HOOK_NAME = 'opl-pin-shell-interpreter'

/** Absolute pinned interpreter, handed to the hook through the launch environment. */
export const POOL_SHELL_VARIABLE = 'OPL_POOL_SHELL'
/** JSON argv array for the pinned interpreter, e.g. `["--noprofile","--norc","-c"]`. */
export const POOL_SHELL_ARGS_VARIABLE = 'OPL_POOL_SHELL_ARGS'
/**
 * Optional audit file. Every applied rewrite appends one JSON line describing the
 * pin and the call, never the command text, so a session can be checked without
 * re-running it and without recording whatever the model wrote.
 */
export const POOL_SHELL_AUDIT_VARIABLE = 'OPL_POOL_SHELL_AUDIT'
/** The audit trail is truncated above this size so it stays a diagnostic, not a transcript. */
export const POOL_AUDIT_MAX_BYTES = 262_144
/** Real Git Bash runs as an MSYS shell; this is the marker that proves it. */
export const POOL_MSYS_MARKER = 'OPL_POOL_BASH:'

/**
 * Bash argv for a non-interactive Git Bash.
 *
 * `--noprofile --norc` keeps the user's shell startup out of a pinned tool run
 * and `-c` is the only mode the interpreter accepts for one command string.
 * `--login` is deliberately absent: it would re-read the login profile that the
 * two flags above exclude.
 */
export const POOL_GIT_BASH_ARGS: readonly string[] = ['--noprofile', '--norc', '-c']

/** Normalize a Windows path the way the official tool call carried a proven path. */
export function poolShellPath(path: string): string {
  return path.replace(/\\/gu, '/')
}

/**
 * The hook script the official CLI executes through `cmd /c` or `/bin/sh -c`.
 *
 * It is written as ESM because the suite launches it with the Host's own Node
 * runtime (`ELECTRON_RUN_AS_NODE=1`), which is what the native bridges already
 * use. The script reads stdin once, rewrites only the interpreter fields, and
 * keeps every other field of the model's arguments. A missing or unusable pin is
 * a block with an explicit reason: the suite refuses to let the call run on
 * PowerShell, CMD or WSL instead.
 * @returns the complete hook program.
 */
export function poolShellHookSource(): string {
  return [
    "import fs from 'node:fs'",
    '',
    'const readInput = () => {',
    '  try {',
    '    return fs.readFileSync(0, "utf8")',
    '  } catch {',
    "    return ''",
    '  }',
    '}',
    'const block = (reason) => {',
    '  process.stderr.write(reason + "\\n")',
    '  process.exit(2)',
    '}',
    'const main = () => {',
    '  let payload',
    '  try {',
    '    payload = JSON.parse(readInput() || "{}")',
    '  } catch {',
    '    return',
    '  }',
    '  if (payload.hook_event_name !== "PreToolUse") return',
    '  const input = payload.tool_input',
    '  if (!input || typeof input !== "object" || Array.isArray(input)) return',
    '  const shell = process.env[' + JSON.stringify(POOL_SHELL_VARIABLE) + ']',
    '  const rawArgs = process.env[' + JSON.stringify(POOL_SHELL_ARGS_VARIABLE) + ']',
    '  if (!shell) block("OPL shell pin is not configured; refusing to run the tool on an unpinned interpreter.")',
    '  let args',
    '  try {',
    '    args = JSON.parse(rawArgs)',
    '  } catch {',
    '    args = undefined',
    '  }',
    '  if (!Array.isArray(args) || args.some((item) => typeof item !== "string"))',
    '    block("OPL shell pin arguments are not a JSON string array; refusing to run the tool.")',
    '  if (!fs.existsSync(shell))',
    '    block("Pinned shell is missing: " + shell + ". Install Git for Windows; no fallback to PowerShell, CMD or WSL.")',
    '  const updated = Object.assign({}, input, { shell, shell_args: args })',
    '  const audit = process.env[' + JSON.stringify(POOL_SHELL_AUDIT_VARIABLE) + ']',
    '  if (audit) {',
    '    try {',
    '      // Keep the audit bounded: it is a diagnostic trail, not a transcript.',
    '      if (fs.existsSync(audit) && fs.statSync(audit).size > ' +
      String(POOL_AUDIT_MAX_BYTES) +
      ') fs.writeFileSync(audit, "")',
    '      fs.appendFileSync(',
    '        audit,',
    '        JSON.stringify({',
    '          tool_call_id: payload.tool_call_id ?? null,',
    '          shell,',
    '          shell_args: args,',
    '          rewrote: typeof input.shell === "string" && input.shell !== shell,',
    '        }) + "\\n",',
    '        "utf8",',
    '      )',
    '    } catch {}',
    '  }',
    '  process.stdout.write(JSON.stringify({ hook_specific_output: { updated_input: updated } }))',
    '}',
    'main()',
    '',
  ].join('\n')
}

/** POSIX shim: the suite Node runtime executes the hook file. */
export function poolHookCommandPosix(nodePath: string, hookPath: string): string {
  return `"${nodePath}" "${hookPath}"`
}

/**
 * Windows shim body: the suite Node runtime executes the hook file next to it.
 *
 * `%~dp0` resolves the hook beside the shim, so the shim stays valid wherever
 * the suite writes its harness home.
 */
export function poolHookCommandWindows(nodePath: string): string {
  return '@echo off\r\n' + `"${nodePath}" "%~dp0${POOL_HOOK_FILE}"\r\n`
}

/** The hook command for this platform. */
export function poolHookCommand(
  platform: NodeJS.Platform,
  nodePath: string,
  hookPath: string,
): string {
  return platform === 'win32' ? POOL_HOOK_COMMAND_NAME : poolHookCommandPosix(nodePath, hookPath)
}

/** File name of the hook program inside the suite-owned harness home. */
export const POOL_HOOK_FILE = 'pool-shell-hook.mjs'
/** File name of the generated settings file inside the suite-owned harness home. */
export const POOL_SETTINGS_FILE = 'settings.yaml'
/**
 * Bare command name of the Windows shim.
 *
 * The official CLI runs a hook command through `cmd /c` and hands the string
 * over verbatim. `cmd` then tries to execute a quoted path literally, which is
 * why `command: "C:\...\pool-shell-hook.cmd"` failed with
 * `hook failure surfaced to model ... FAILED: exited with status 1` in the ACP
 * log of a measured run. A bare name is resolved through `PATH`, which the
 * adapter owns, so the hook starts whether or not the user's data directory
 * contains a space.
 */
export const POOL_HOOK_COMMAND_NAME = 'opl-pool-shell-hook.cmd'

/**
 * YAML single-quoted scalar. Windows hook commands carry backslashes and a
 * quoted path with spaces; single quotes keep every backslash literal, and a
 * doubled quote is the only escape YAML needs here. JSON double-quoting would
 * double-escape the path and the official CLI would then fail to start the
 * hook, which fails open and silently leaves the model's own interpreter.
 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

/**
 * Exact settings file the ACP launch passes with `--settings`.
 *
 * Only the `hooks` section is written. Endpoint, credential, model and approval
 * mode travel through the launch environment and the ACP session, so this file
 * holds nothing a user could edit into a different account, and a byte change
 * is refused rather than silently repaired.
 * @param command - the hook command line for this platform.
 * @returns the settings YAML text.
 */
export function poolSettings(command: string): string {
  return (
    'hooks:\n' +
    '  PreToolUse:\n' +
    '    - name: ' +
    POOL_SHELL_HOOK_NAME +
    '\n' +
    '      matcher: shell\n' +
    '      command: ' +
    yamlScalar(command) +
    '\n' +
    '      timeout: 15\n'
  )
}

/**
 * The only settings bytes this adapter accepts for a given hook command.
 *
 * Layouts exist because the hook command embeds absolute paths: the accepted
 * values are the ones this adapter itself produced for the current shell pin.
 * @param command - the hook command line for this platform.
 * @returns acceptable file contents, newest layout first.
 */
export function poolSettingsLayouts(command: string): string[] {
  return [poolSettings(command)]
}

/** Launch environment variable that makes a bundled Node runtime behave like Node. */
export const POOL_NODE_ENV = 'ELECTRON_RUN_AS_NODE'
