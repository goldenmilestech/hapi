import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '@/ui/logger'
import { getProjectPath } from './utils/path'

type TranscriptRecord = {
    uuid?: unknown
    parentUuid?: unknown
    sessionId?: unknown
    isSidechain?: unknown
    [key: string]: unknown
}

export type ForkClaudeTranscriptOptions = {
    /** Session working directory; selects the Claude project transcript folder. */
    workingDirectory: string
    /** Native Claude session id whose transcript is being truncated. */
    sourceSessionId: string
    /** Transcript entry uuid to keep as the new branch tip. */
    boundaryUuid: string
    /** Override for tests; defaults to a fresh uuid. */
    newSessionId?: string
}

/**
 * Fork a Claude session at an existing transcript entry.
 *
 * Claude only exposes `--fork-session` for the live tail. To branch at an
 * earlier reply we copy the source `.jsonl` up to the boundary entry's
 * ancestor chain into a new session file, then let the caller resume it with
 * a normal `--resume`. Records outside the chain (sidechains, summaries,
 * bookkeeping rows without uuids) are intentionally dropped.
 *
 * Returns the new native session id.
 */
export function forkClaudeTranscriptAtMessage(options: ForkClaudeTranscriptOptions): string {
    const newSessionId = options.newSessionId ?? randomUUID()
    const projectPath = getProjectPath(options.workingDirectory)
    const sourcePath = join(projectPath, `${options.sourceSessionId}.jsonl`)
    const targetPath = join(projectPath, `${newSessionId}.jsonl`)

    let raw: string
    try {
        raw = readFileSync(sourcePath, 'utf8')
    } catch (error) {
        throw new Error(`Claude transcript is not readable: ${error instanceof Error ? error.message : String(error)}`)
    }

    const records: TranscriptRecord[] = []
    for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
            records.push(JSON.parse(trimmed) as TranscriptRecord)
        } catch {
            // A concurrent writer may leave a torn tail; ignore it.
        }
    }

    const byUuid = new Map<string, TranscriptRecord>()
    for (const record of records) {
        if (typeof record.uuid === 'string' && record.uuid.length > 0) {
            byUuid.set(record.uuid, record)
        }
    }
    if (!byUuid.has(options.boundaryUuid)) {
        throw new Error('Fork boundary is not present in the Claude transcript')
    }

    const chain = new Set<string>()
    let cursor: string | null = options.boundaryUuid
    while (cursor && !chain.has(cursor)) {
        chain.add(cursor)
        const record = byUuid.get(cursor)
        const parent = record?.parentUuid
        cursor = typeof parent === 'string' && parent.length > 0 ? parent : null
    }

    let written = 0
    const output: string[] = []
    for (const record of records) {
        const uuid = typeof record.uuid === 'string' ? record.uuid : null
        if (!uuid || !chain.has(uuid)) continue
        if (record.isSidechain === true) continue
        output.push(JSON.stringify({ ...record, sessionId: newSessionId }))
        written += 1
    }
    if (written === 0) {
        throw new Error('Fork boundary has no transcript history to copy')
    }

    writeFileSync(targetPath, `${output.join('\n')}\n`, 'utf8')
    logger.debug(`[historyFork] forked ${options.sourceSessionId} -> ${newSessionId} at ${options.boundaryUuid} (${written} records)`)
    return newSessionId
}
