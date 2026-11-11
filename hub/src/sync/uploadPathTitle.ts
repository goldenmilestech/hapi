/**
 * Legacy CLI releases (<= 0.30.x) titled a session with their raw first
 * prompt, before upload references were stripped. A first message that
 * carried an image was therefore titled
 * `@/var/folders/.../T/hapi-blobs/<session>/<file>.png…` — a machine-local
 * upload path truncated at the 80-character title limit. Such a title is
 * never usable: it hides the Hub-derived prompt title and blocks generated
 * titles, so every title source treats it as absent.
 */
const UPLOAD_PATH_TOKEN = /^@\S*[/\\]hapi-blobs[/\\]\S*$/
/** A bare `@`-prefixed absolute path; also catches a path truncated before the upload marker. */
const BARE_AT_PATH = /^@(?:[A-Za-z]:)?[/\\]\S*$/

export function isUploadPathTitle(text: unknown): boolean {
    if (typeof text !== 'string') return false
    const trimmed = text.trim()
    if (trimmed.length === 0) return false
    return UPLOAD_PATH_TOKEN.test(trimmed) || BARE_AT_PATH.test(trimmed)
}

/** True when a stored title text is present and not a legacy upload path. */
export function isUsableTitleText(text: unknown): boolean {
    return typeof text === 'string' && text.trim().length > 0 && !isUploadPathTitle(text)
}

/** Drop `@<upload path>` tokens the CLI prepends to a prompt before delivery. */
export function stripUploadPathReferences(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter((part) => !UPLOAD_PATH_TOKEN.test(part))
        .join(' ')
        .trim()
}
