import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { sampleInsurers } from './catalogue'
import { apiError, isMissingFunction, NotReadyError } from './errors'

/**
 * The insurer a patient is treated under (0139): recorded at registration, when a visit starts or
 * in the patient's file; every new visit of the patient starts under it, so its lines take that
 * insurer's prices and coverage. None: a private patient.
 * Live: `patient_insurance`, `save_patient_insurance`. Sample: in memory.
 */
export interface PatientInsurance {
  coverageId: string
  payerId: string
  payer: string
  payerType: string
  memberNumber: string | null
  since: string | null
}

const sampleInsurance = new Map<string, PatientInsurance | null>()

const key = (patientId: string | null) => ['patient', patientId, 'insurance'] as const

export function usePatientInsurance(patientId: string | null) {
  return useQuery({
    queryKey: key(patientId),
    enabled: !!patientId,
    queryFn: async (): Promise<PatientInsurance | null> => {
      if (!patientId) return null
      if (!supabase) return sampleInsurance.get(patientId) ?? null
      const { data, error } = await supabase.rpc('patient_insurance', { p_patient: patientId })
      // a database before 0139: no insurer recorded on the patient
      if (error && isMissingFunction(error)) return null
      if (error) throw apiError(error)
      return (data as PatientInsurance | null) ?? null
    },
  })
}

export function useSavePatientInsurance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (i: {
      patientId: string
      payerId: string | null
      memberNumber?: string | null
    }): Promise<PatientInsurance | null> => {
      if (!supabase) {
        const ins = sampleInsurers.find((x) => x.id === i.payerId)
        const v: PatientInsurance | null = ins
          ? {
              coverageId: `cov-${i.patientId}-${ins.id}`,
              payerId: ins.id,
              payer: ins.name,
              payerType: ins.type,
              memberNumber: i.memberNumber?.trim() || null,
              since: new Date().toISOString(),
            }
          : null
        sampleInsurance.set(i.patientId, v)
        return v
      }
      const { data, error } = await supabase.rpc('save_patient_insurance', {
        p_patient: i.patientId,
        p_payer: i.payerId,
        p_member_number: i.memberNumber?.trim() || null,
      })
      if (error && isMissingFunction(error)) throw new NotReadyError()
      if (error) throw apiError(error)
      return (data as PatientInsurance | null) ?? null
    },
    onSuccess: (_d, i) => {
      void qc.invalidateQueries({ queryKey: key(i.patientId) })
      void qc.invalidateQueries({ queryKey: ['patient', i.patientId] })
    },
  })
}
