import { useEffect, useRef, useState } from 'react'
import type { CooperationSettings } from '../../contracts/types.ts'
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import { defaultCollaborationT, type CollaborationT } from './collaboration-locales.ts'

export function useCooperationSettings(
  call?: ExecutionCall,
  t: CollaborationT = defaultCollaborationT,
) {
  const [value, setValue] = useState<CooperationSettings>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const running = useRef(false)
  const tRef = useRef(t)
  tRef.current = t
  useEffect(() => {
    let live = true
    if (call)
      void call('cooperation-settings')
        .then((next) => {
          if (live) {
            setValue(next)
            setError('')
          }
        })
        .catch(() => {
          if (live) setError(tRef.current('cooperationReadFailed'))
        })
    return () => {
      live = false
    }
  }, [call])
  const save = async (next: CooperationSettings) => {
    if (!call || running.current) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      setValue(await call('save-cooperation-settings', next))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tRef.current('cooperationSaveFailed'))
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  const reload = async () => {
    if (call) setValue(await call('cooperation-settings'))
  }
  return { reload, cooperation: value, error, busy, loading: !!call && !value && !error, save }
}
