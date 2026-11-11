import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forkClaudeTranscriptAtMessage } from './historyFork'
import { getProjectPath } from './utils/path'

type Row = {
    uuid: string
    parentUuid: string | null
    sessionId: string
    type: string
    message?: unknown
    isSidechain?: boolean
}

describe('forkClaudeTranscriptAtMessage', () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const workingDirectory = '/tmp/claude-history-fork-workdir'
    const sourceSessionId = 'source-session'
    let configDir = ''

    beforeEach(() => {
        configDir = mkdtempSync(join(tmpdir(), 'claude-history-fork-'))
        process.env.CLAUDE_CONFIG_DIR = configDir
        mkdirSync(getProjectPath(workingDirectory), { recursive: true })
    })

    afterEach(() => {
        if (previousConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR
        } else {
            process.env.CLAUDE_CONFIG_DIR = previousConfigDir
        }
        rmSync(configDir, { recursive: true, force: true })
    })

    function writeTranscript(rows: Row[]): string {
        const path = join(getProjectPath(workingDirectory), `${sourceSessionId}.jsonl`)
        writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
        return path
    }

    function readRows(sessionId: string): Row[] {
        const path = join(getProjectPath(workingDirectory), `${sessionId}.jsonl`)
        return readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Row)
    }

    it('copies the ancestor chain up to the boundary under a new session id', () => {
        writeTranscript([
            { uuid: 'u1', parentUuid: null, sessionId: sourceSessionId, type: 'user' },
            { uuid: 'u2', parentUuid: 'u1', sessionId: sourceSessionId, type: 'assistant' },
            { uuid: 'u3', parentUuid: 'u2', sessionId: sourceSessionId, type: 'user' },
            { uuid: 'u4', parentUuid: 'u3', sessionId: sourceSessionId, type: 'assistant' }
        ])

        const childId = forkClaudeTranscriptAtMessage({
            workingDirectory,
            sourceSessionId,
            boundaryUuid: 'u2',
            newSessionId: 'child-session'
        })

        expect(childId).toBe('child-session')
        const rows = readRows('child-session')
        expect(rows.map((row) => row.uuid)).toEqual(['u1', 'u2'])
        expect(rows.every((row) => row.sessionId === 'child-session')).toBe(true)
    })

    it('drops sidechain records and returns only the main chain', () => {
        writeTranscript([
            { uuid: 'u1', parentUuid: null, sessionId: sourceSessionId, type: 'user' },
            { uuid: 's1', parentUuid: 'u1', sessionId: sourceSessionId, type: 'assistant', isSidechain: true },
            { uuid: 'u2', parentUuid: 'u1', sessionId: sourceSessionId, type: 'assistant' }
        ])

        const childId = forkClaudeTranscriptAtMessage({
            workingDirectory,
            sourceSessionId,
            boundaryUuid: 'u2'
        })

        expect(readRows(childId).map((row) => row.uuid)).toEqual(['u1', 'u2'])
    })

    it('rejects a boundary that is not in the transcript', () => {
        writeTranscript([
            { uuid: 'u1', parentUuid: null, sessionId: sourceSessionId, type: 'user' }
        ])

        expect(() => forkClaudeTranscriptAtMessage({
            workingDirectory,
            sourceSessionId,
            boundaryUuid: 'missing'
        })).toThrow('Fork boundary is not present in the Claude transcript')
    })

    it('rejects an unreadable source transcript', () => {
        expect(() => forkClaudeTranscriptAtMessage({
            workingDirectory,
            sourceSessionId: 'absent',
            boundaryUuid: 'u1'
        })).toThrow('Claude transcript is not readable')
    })
})
