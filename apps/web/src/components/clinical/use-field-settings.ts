import { useTranslation } from 'react-i18next'
import { usePatientBuiltins, usePatientFields, type PatientFieldDef } from '@/lib/api/patients'
import { BUILTIN_DEFAULTS, type BuiltinStates } from '@/lib/patient-rules'

/** The clinic's settings for the forms: the built-in fields' states and the manager's fields. */
export function useFieldSettings(): { states: BuiltinStates; defs: PatientFieldDef[] } {
  const { data: states = BUILTIN_DEFAULTS } = usePatientBuiltins()
  const { data: defs = [] } = usePatientFields()
  return { states, defs }
}

/** A missing-field key (files.missing.*, extra:<key>) in words. */
export function useMissingLabel() {
  const { t } = useTranslation()
  const { defs } = useFieldSettings()
  return (key: string) =>
    key.startsWith('extra:')
      ? (defs.find((d) => d.key === key.slice(6))?.label ?? key.slice(6))
      : t(`files.missing.${key}`)
}
