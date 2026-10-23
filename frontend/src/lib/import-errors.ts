/**
 * Turns an import failure into something the person who typed the username can
 * act on.
 *
 * The import runs through Chess.com's public API, and its errors arrive as raw
 * HTTP plumbing — a 404 for a player archives URL, complete with a link to the
 * MDN page for status codes. The most common cause is a typo, so that case
 * gets a plain sentence. Anything unrecognised is passed through untouched
 * rather than replaced by a vague apology.
 */
export function describeImportError(message: string, username: string): string {
  const text = message ?? ''

  if (/\/pub\/player\//i.test(text) && /\b404\b/.test(text)) {
    const name = username.trim()
    return name
      ? `Chess.com has no account called “${name}”. Check the spelling, and use your Chess.com username, not your email address.`
      : 'Chess.com has no account with that name. Check the spelling.'
  }

  if (/\b429\b/.test(text) || /rate.?limit/i.test(text)) {
    return 'Chess.com is limiting requests right now. Wait a minute and try again.'
  }

  if (/\b(500|502|503|504)\b/.test(text) && /chess\.com/i.test(text)) {
    return 'Chess.com is not responding right now. Try again in a few minutes.'
  }

  return text
}
