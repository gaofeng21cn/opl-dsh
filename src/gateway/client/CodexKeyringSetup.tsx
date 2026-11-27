import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../../shared/client/SettingsSection.module.css'

export interface CodexKeyringSetupProps {
  targets(): Promise<{ platform: string; distros: string[] }>
  configure(
    target: string,
    distro: string,
    install: boolean,
  ): Promise<{ configured: boolean; needsInstall: boolean; message: string }>
}

export function CodexKeyringSetup({ targets, configure }: CodexKeyringSetupProps) {
  const [options, setOptions] = useState<Awaited<ReturnType<typeof targets>>>()
  const [target, setTarget] = useState('')
  const [distro, setDistro] = useState('')
  const [result, setResult] = useState<Awaited<ReturnType<typeof configure>>>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const working = useRef(false)

  async function load() {
    if (working.current || options) return
    working.current = true
    setLoadFailed(false)
    try {
      const available = await targets()
      setOptions(available)
      if (available.platform === 'darwin') setTarget('mac')
      if (available.distros.length === 1) setDistro(available.distros[0]!)
    } catch {
      setLoadFailed(true)
    } finally {
      working.current = false
    }
  }

  async function apply() {
    if (working.current || !target || (target === 'wsl' && !distro)) return
    working.current = true
    setPending(true)
    try {
      setResult(
        await configure(
          target,
          target === 'wsl' ? distro : '',
          target === 'wsl' && result?.needsInstall === true,
        ),
      )
    } catch {
      setResult({ configured: false, needsInstall: false, message: '未能确认配置结果，请重试。' })
    } finally {
      working.current = false
      setPending(false)
    }
  }

  return (
    <details
      className={css.details}
      onToggle={(event) => {
        if (event.currentTarget.open) void load()
      }}
    >
      <summary>配置外部 Codex</summary>
      <div className={css.detailsBody}>
        {!options ? (
          loadFailed ? (
            <>
              <p className={css.error} role="alert">
                未能读取运行环境。
              </p>
              <Button variant="outline" onClick={() => void load()}>
                重试
              </Button>
            </>
          ) : (
            <p className={css.muted} role="status">
              正在读取运行环境…
            </p>
          )
        ) : options.platform !== 'darwin' && options.platform !== 'win32' ? (
          <p className={css.muted}>此设备暂不支持一键配置。</p>
        ) : (
          <>
            <p className={css.muted}>
              使用 OPL 网关连接 Codex，初始模型为 gpt-6.2-sol，可在 Codex 中切换。
            </p>
            {options.platform === 'win32' && (
              <label className={css.field}>
                运行环境
                <select
                  className={css.input}
                  value={target}
                  disabled={pending}
                  onChange={(event) => {
                    setTarget(event.target.value)
                    setResult(undefined)
                  }}
                >
                  <option value="">请选择</option>
                  <option value="windows">Windows 原生</option>
                  <option value="wsl">WSL</option>
                </select>
              </label>
            )}
            {target === 'wsl' && (
              <label className={css.field}>
                WSL 发行版
                <select
                  className={css.input}
                  value={distro}
                  disabled={pending || !options.distros.length}
                  onChange={(event) => {
                    setDistro(event.target.value)
                    setResult(undefined)
                  }}
                >
                  <option value="">
                    {options.distros.length
                      ? '请选择运行 Codex 的发行版'
                      : '未检测到可用的 WSL 发行版'}
                  </option>
                  {options.distros.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className={css.muted}>
              {target === 'windows'
                ? '专用密钥将存入 Windows 凭据管理器。'
                : target === 'wsl'
                  ? '专用密钥将存入所选发行版的钥匙串。'
                  : target === 'mac'
                    ? '专用密钥将存入 macOS 钥匙串。'
                    : '专用密钥将存入所选环境的系统凭据库。'}
            </p>
            <Button
              variant="outline"
              disabled={pending || result?.configured || !target || (target === 'wsl' && !distro)}
              onClick={() => void apply()}
            >
              {pending
                ? '正在配置…'
                : result?.configured
                  ? '已配置'
                  : result?.needsInstall
                    ? '安装钥匙串并配置'
                    : '一键配置'}
            </Button>
            {result && !pending && (
              <p
                role="status"
                className={!result.configured && !result.needsInstall ? css.error : css.muted}
              >
                {result.message}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  )
}
