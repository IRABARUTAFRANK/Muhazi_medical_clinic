/**
 * A booking whose visit closed before anyone saw the patient (migration 0101) is stored as
 * cancelled with the reason "left_unseen" or "left_unseen: <why>". The screens show it as its own
 * status, "Left before being seen", with the reason given (if any) as the reason.
 */
export const LEFT_UNSEEN = 'left_unseen'

export function withLeftUnseen<T extends { status: string; cancelReason?: string | null }>(
  b: T,
): T {
  const reason = b.cancelReason ?? ''
  if (b.status !== 'cancelled' || !reason.startsWith(LEFT_UNSEEN)) return b
  const why = reason.slice(LEFT_UNSEEN.length).replace(/^:\s*/, '').trim()
  return { ...b, status: LEFT_UNSEEN, cancelReason: why || null }
}
