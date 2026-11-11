import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { extractUserText, TITLE_SUGGESTION_MAX_TITLE_CHARS } from './titleSuggestion'
import { isUploadPathTitle, stripUploadPathReferences } from './uploadPathTitle'

/**
 * Provisional session title from a user prompt, like a chat app's untitled
 * conversation. Slash commands are skipped because they name an action, not
 * the conversation.
 */
export function createPromptTitle(content: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (record?.role !== 'user') return null
    const rawText = extractUserText(record.content)?.replace(/\s+/g, ' ').trim()
    if (!rawText) return null
    const text = stripUploadPathReferences(rawText)
    if (!text || text.startsWith('/') || isUploadPathTitle(text)) return null
    if (text.length <= TITLE_SUGGESTION_MAX_TITLE_CHARS) return text
    return text.slice(0, TITLE_SUGGESTION_MAX_TITLE_CHARS - 1).trimEnd() + '…'
}
