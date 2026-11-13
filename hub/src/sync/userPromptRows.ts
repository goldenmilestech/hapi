import { isObject, safeStringify } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { StoredMessage } from '../store'

/** CLI command echoes carry these tags; they are output, not prompts. */
const CLI_OUTPUT_TAG_PATTERN = /<(?:local-command-[a-z-]+|command-(?:name|message|args))>/i

/** Mirror the web renderer's user-message text extraction. */
export function extractStoredUserText(content: unknown): string {
    if (typeof content === 'string') {
        return content
    }
    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return content.text
    }
    return safeStringify(content)
}

/** CLI command echoes render as `cli-output`, so they never become prompts. */
export function isCliOutputUserMessage(text: string, meta: unknown): boolean {
    return isObject(meta)
        && meta.sentFrom === 'cli'
        && CLI_OUTPUT_TAG_PATTERN.test(text)
}

/**
 * A user-authored prompt row, whether or not the CLI has consumed it yet.
 * Used to keep an in-progress card from falling back to the previous prompt
 * while a newly sent prompt is still queued.
 */
export function isUserPrompt(message: StoredMessage): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (record?.role !== 'user') return false
    if (isObject(record.meta) && record.meta.isTranscriptEcho === true) return false
    return !isCliOutputUserMessage(extractStoredUserText(record.content), record.meta)
}

/**
 * Whether a stored row is a prompt the user actually sent: delivered, a user
 * record, not the CLI's transcript echo of a hub prompt, and not a command
 * echo. Session stats count turns with this so replays never inflate them.
 */
export function isDeliveredUserPrompt(message: StoredMessage): boolean {
    if (message.invokedAt === null) return false
    return isUserPrompt(message)
}
