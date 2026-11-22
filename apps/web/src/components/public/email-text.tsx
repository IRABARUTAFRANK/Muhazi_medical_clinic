/**
 * An e-mail address in a column that may be narrower than it is: it breaks before its "@"
 * (and inside a part only when that part alone is still too long), instead of dropping its last
 * letter onto a line of its own.
 */
export function EmailText({ email }: { email: string }) {
  const at = email.indexOf('@')
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {at > 0 ? (
        <>
          {email.slice(0, at)}
          <wbr />
          {email.slice(at)}
        </>
      ) : (
        email
      )}
    </span>
  )
}
