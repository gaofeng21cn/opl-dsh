import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { codexWslGuest } from './codex-wsl-guest.ts'
import { OPL_GATEWAY_INFERENCE_BASE_URL } from './opl-credentials.ts'

const messages: Record<number, string> = {
  10: '请确认所选 WSL 发行版仍可用。',
  11: '此发行版缺少钥匙串组件，可以为它安装。',
  12: '发现已有 Codex 登录，已保留。请先在所选发行版退出原登录。',
  13: 'WSL Codex 配置路径不可写，或不是当前 Linux 用户的独立目录。',
  14: '此发行版不支持一键安装钥匙串。请使用带 Secret Service 的 Linux 用户环境。',
  15: '未找到此发行版的 Linux Codex CLI，请先安装 Codex。',
  16: '无法读写 WSL 用户钥匙串。请检查用户会话和解锁窗口，并确认已设置钥匙串密码。',
  17: 'WSL 配置或登录在操作期间发生变化，请重试。',
  18: 'Codex 没有确认配置或凭据，请检查所选发行版的 Codex 版本。',
  19: '此发行版的默认用户必须是普通 Linux 用户。',
  20: 'WSL 钥匙串安装未完成。请检查发行版软件源和网络后重试。',
  21: 'WSL 用户会话总线未运行。请确认所选发行版已启用 systemd，保存工作并重启该发行版后重试。',
  22: '所选 WSL 用户的默认钥匙串未确认加密。请为默认 GNOME 钥匙串设置非空密码后重试。',
}

export class CodexWslError extends Error {
  readonly code: string
  constructor(status: number) {
    super(messages[status] ?? messages[18])
    this.code = status === 11 ? 'WSL_KEYRING_INSTALL_REQUIRED' : 'WSL_CODEX_SETUP_FAILED'
  }
}
type Result = { status: number; output: Buffer }
async function invoke(args: string[], input?: string, timeout = 150_000): Promise<Result> {
  if (process.platform !== 'win32') throw new CodexWslError(10)
  const proc = spawn(
    win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'wsl.exe'),
    args,
    {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  )
  const chunks: Buffer[] = []
  let bytes = 0
  proc.stdout.on('data', (chunk: Buffer) => {
    if (bytes + chunk.length <= 32_768) chunks.push(chunk)
    bytes += chunk.length
  })
  proc.stdin.on('error', () => {})
  const result = new Promise<Result>((resolve, reject) => {
    proc.once('error', () => reject(new CodexWslError(10)))
    proc.once('close', (status) => resolve({ status: status ?? 18, output: Buffer.concat(chunks) }))
  })
  const timer = setTimeout(() => proc.kill(), timeout)
  proc.stdin.end(input)
  try {
    return await result
  } finally {
    clearTimeout(timer)
  }
}

/** WSL lists locally registered distributions as UTF-16LE with current Windows builds. */
export function parseCodexWslDistros(output: Buffer): string[] {
  const text = output.toString(output.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '')
  return [
    ...new Set(
      text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(
          (name) =>
            /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/u.test(name) &&
            !/^(docker-desktop|rancher-desktop|podman-machine)(?:[-.]|$)/iu.test(name),
        ),
    ),
  ]
}

export async function listCodexWslDistros(): Promise<string[]> {
  const result = await invoke(['--list', '--quiet'], undefined, 15_000)
  if (result.status !== 0) return []
  return parseCodexWslDistros(result.output)
}

const detect = `
[ "$(/usr/bin/id -u)" -ne 0 ] || exit 19
if [ -x /usr/bin/secret-tool ] && [ -x /usr/bin/gnome-keyring-daemon ] && [ -x /usr/bin/dbus-daemon ] && [ -f /usr/lib/systemd/user/dbus.socket ] && /usr/bin/python3 -I -c 'import json, secrets, pathlib' 2>/dev/null; then exit 0; fi
[ -x /usr/bin/apt-get ] && /usr/bin/grep -Eq '^ID="?(debian|ubuntu)"?$' /etc/os-release || exit 14
exit 11`
const rootInstall = `cd / || exit 20
/usr/bin/grep -Eq '^ID="?(debian|ubuntu)"?$' /etc/os-release || exit 14
/usr/bin/apt-get -qq -o Acquire::Retries=1 update >/dev/null &&
/usr/bin/apt-get -y --no-remove --no-install-recommends install libsecret-tools gnome-keyring dbus-user-session python3 gcr >/dev/null || exit 20`

/** Preflight the listed distribution as its default user before requesting a gateway key. */
export async function prepareCodexWsl(distro: string, installKeyring = false) {
  async function requireDistro() {
    if (!(await listCodexWslDistros()).includes(distro)) throw new CodexWslError(10)
  }
  await requireDistro()
  const prefix = ['--distribution', distro, '--cd', '/']
  const detected = await invoke([...prefix, '--exec', '/bin/sh', '-c', detect])
  if (detected.status === 11 && installKeyring) {
    const installed = await invoke(
      [
        ...prefix,
        '--user',
        'root',
        '--exec',
        '/usr/bin/env',
        '-i',
        'HOME=/root',
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
        'DEBIAN_FRONTEND=noninteractive',
        '/bin/sh',
        '-ec',
        rootInstall,
      ],
      undefined,
      360_000,
    )
    if (installed.status !== 0) throw new CodexWslError(installed.status === 14 ? 14 : 20)
  } else if (detected.status !== 0) throw new CodexWslError(detected.status)
  const payload = Buffer.from(codexWslGuest).toString('base64')
  const guest = [
    ...prefix,
    '--exec',
    '/usr/bin/python3',
    '-I',
    '-c',
    "import base64;exec(base64.b64decode('" + payload + "'))",
    OPL_GATEWAY_INFERENCE_BASE_URL,
  ]
  const probed = await invoke([...guest, 'probe'])
  if (probed.status !== 0) throw new CodexWslError(probed.status)
  const identity = probed.output.toString('ascii').trim()
  if (!/^[0-9a-f]{64}$/u.test(identity)) throw new CodexWslError(18)
  return {
    async configure(key: string) {
      if (key.length > 16_384 || !/^[!-~]+$/u.test(key)) throw new CodexWslError(18)
      await requireDistro()
      const result = await invoke([...guest, 'configure', identity], key + '\n')
      if (result.status !== 0) throw new CodexWslError(result.status)
    },
  }
}
