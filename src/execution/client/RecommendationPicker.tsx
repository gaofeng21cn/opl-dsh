import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { displayModelSource } from '../contracts/catalog.ts'
import type { ExecutionCatalog } from '../contracts/catalog.ts'
import css from './RecommendationPicker.module.css'
import { combinationChoices } from './combination-choices.ts'

/** One selection surface controls saved configurations and new recommendations. */
export function RecommendationPicker({
  catalog,
  busy,
  onAdd,
}: {
  catalog: ExecutionCatalog
  busy: boolean
  onAdd: (selected: ReadonlySet<string>) => Promise<void>
}) {
  const candidates = combinationChoices(catalog).map((item) => [item.key, item] as const)
  const enabled = () => new Set(candidates.filter(([, item]) => item.enabled).map(([key]) => key))
  const [selected, setSelected] = useState<Set<string>>(enabled)
  useEffect(() => {
    setSelected(enabled())
  }, [catalog])
  const groups = [...new Set(candidates.map(([, item]) => item.harnessRef))]
  const count = candidates.filter(([key]) => selected.has(key)).length
  const toggle = (keys: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) checked ? next.add(key) : next.delete(key)
      return next
    })
  if (!candidates.length) return null
  return (
    <div className={css.picker}>
      <div className={css.toolbar}>
        <strong>选择要启用的组合</strong>
        <Button
          disabled={busy}
          onClick={() =>
            toggle(
              candidates.map(([key]) => key),
              true,
            )
          }
        >
          全选
        </Button>
        <Button disabled={busy || !count} onClick={() => setSelected(new Set())}>
          取消全选
        </Button>
      </div>
      <div className={css.groups}>
        {groups.map((harness) => {
          const items = candidates.filter(([, item]) => item.harnessRef === harness)
          const checked = items.filter(([key]) => selected.has(key)).length
          const name = catalog.harnesses.find((item) => item.id === harness)?.name ?? harness
          return (
            <div className={css.group} key={harness}>
              <label className={css.groupLabel}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={checked === items.length}
                  ref={(node) => {
                    if (node) node.indeterminate = checked > 0 && checked < items.length
                  }}
                  data-opl-recommendation-group={harness}
                  onChange={(event) =>
                    toggle(
                      items.map(([key]) => key),
                      event.target.checked,
                    )
                  }
                />
                {name}（{checked}/{items.length}）
              </label>
              {items.map(([key, item]) => (
                <label className={css.item} key={key}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={selected.has(key)}
                    data-opl-recommendation-item={key}
                    onChange={(event) => toggle([key], event.target.checked)}
                  />
                  <span>
                    {displayModelSource(item.modelRef)} · {item.name}
                  </span>
                </label>
              ))}
            </div>
          )
        })}
      </div>
      <Button
        disabled={busy}
        onClick={() =>
          void onAdd(new Set(candidates.filter(([key]) => selected.has(key)).map(([key]) => key)))
        }
      >
        保存选择（{count}）
      </Button>
    </div>
  )
}
