import type { ModelDefinition } from '../contracts/catalog.ts'
import { defaultExecutionT, type ExecutionSettingsT } from './execution-settings-locales.ts'
import css from './CombinationRows.module.css'

function labelFor(kind: ModelDefinition['unavailableKind'], t: ExecutionSettingsT): string {
  if (kind === 'catalog-missing') return t('availabilityCatalogMissing')
  if (kind === 'disabled') return t('availabilityDisabled')
  if (kind === 'unconfirmed') return t('availabilityUnconfirmed')
  return t('availabilityUnavailable')
}

/** Source and combination rows share compact labels and keep reasons on hover. */
export function ModelAvailabilityStatus({
  available,
  reason,
  unavailableKind,
  t = defaultExecutionT,
}: Pick<ModelDefinition, 'available' | 'reason' | 'unavailableKind'> & {
  t?: ExecutionSettingsT
}) {
  if (available) return null
  const label = labelFor(unavailableKind, t)
  return (
    <span
      className={css.failure}
      title={reason ?? label}
      data-opl-model-availability={unavailableKind ?? 'unavailable'}
    >
      {label}
    </span>
  )
}
