// What a tool made last, offered only while it still matches what the tool is set to.

import { useState } from 'react'

/** Whether two lists of inputs hold the same values in the same order, compared like hook dependencies. */
export function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
}

/**
 * The last result a tool made from `inputs`, or null once any of them has
 * changed, so an old file is never offered for new settings. Changing them
 * back brings the result back.
 */
export function useResult<T>(inputs: readonly unknown[]) {
  const [made, setMade] = useState<{ value: T; from: readonly unknown[] } | null>(null)
  return {
    value: made && sameInputs(made.from, inputs) ? made.value : null,
    /** Forget the last result; the returned function records the next one as made from the inputs as they are now. */
    begin: () => {
      setMade(null)
      return (value: T) => setMade({ value, from: inputs })
    },
    clear: () => setMade(null),
  }
}
