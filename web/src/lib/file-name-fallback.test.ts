import { describe, expect, it } from 'vitest'
import type { FileSearchItem } from '@/types/api'
import {
    fileNameOf,
    isAbsoluteFilePath,
    isMissingFileError,
    rankFileNameCandidates,
} from '@/lib/file-name-fallback'

function file(fullPath: string, modified?: number, fileType: 'file' | 'folder' = 'file'): FileSearchItem {
    const parts = fullPath.split('/')
    return {
        fileName: parts[parts.length - 1] ?? fullPath,
        filePath: parts.slice(0, -1).join('/'),
        fullPath,
        fileType,
        modified,
    }
}

describe('isMissingFileError', () => {
    it('detects Node ENOENT messages from the runner read handler', () => {
        expect(isMissingFileError("ENOENT: no such file or directory, realpath '/repo/proposal.md'")).toBe(true)
        expect(isMissingFileError('Error: no such file or directory')).toBe(true)
    })

    it('does not treat other read failures as missing files', () => {
        expect(isMissingFileError(null)).toBe(false)
        expect(isMissingFileError(undefined)).toBe(false)
        expect(isMissingFileError('Access denied: Path is outside the working directory')).toBe(false)
        expect(isMissingFileError('EACCES: permission denied')).toBe(false)
    })
})

describe('fileNameOf', () => {
    it('handles POSIX and Windows separators', () => {
        expect(fileNameOf('/Users/ada/repo/proposal.md')).toBe('proposal.md')
        expect(fileNameOf('openspec/changes/foo/proposal.md')).toBe('proposal.md')
        expect(fileNameOf('docs\\guide.md')).toBe('guide.md')
        expect(fileNameOf('proposal.md')).toBe('proposal.md')
        expect(fileNameOf('docs/')).toBe('docs')
        expect(fileNameOf('')).toBe('')
    })
})

describe('isAbsoluteFilePath', () => {
    it('recognizes POSIX, Windows drive, and UNC paths', () => {
        expect(isAbsoluteFilePath('/Users/ada/repo/a.md')).toBe(true)
        expect(isAbsoluteFilePath('C:\\repo\\a.md')).toBe(true)
        expect(isAbsoluteFilePath('/repo/a.md')).toBe(true)
        expect(isAbsoluteFilePath('\\\\server\\share\\a.md')).toBe(true)
        expect(isAbsoluteFilePath('docs/a.md')).toBe(false)
        expect(isAbsoluteFilePath('a.md')).toBe(false)
    })
})

describe('rankFileNameCandidates', () => {
    it('keeps only files whose basename matches', () => {
        const ranked = rankFileNameCandidates([
            file('docs/proposal.md', 1),
            file('docs/design.md', 2),
            file('docs/proposal.md.bak', 3),
        ], 'proposal.md')

        expect(ranked.map((entry) => entry.fullPath)).toEqual(['docs/proposal.md'])
    })

    it('prefers candidates sharing the longest trailing directory suffix', () => {
        const ranked = rankFileNameCandidates([
            file('other/docs/README.md', 1),
            file('docs/README.md', 2),
            file('other/README.md', 3),
        ], 'docs/README.md')

        expect(ranked.map((entry) => entry.fullPath)).toEqual([
            'docs/README.md',
            'other/docs/README.md',
            'other/README.md',
        ])
    })

    it('sorts bare-name matches by most recently modified', () => {
        const ranked = rankFileNameCandidates([
            file('openspec/changes/older/proposal.md', 100),
            file('openspec/changes/newer/proposal.md', 300),
            file('openspec/changes/unknown/proposal.md'),
        ], 'proposal.md')

        expect(ranked.map((entry) => entry.fullPath)).toEqual([
            'openspec/changes/newer/proposal.md',
            'openspec/changes/older/proposal.md',
            'openspec/changes/unknown/proposal.md',
        ])
    })

    it('ranks exact-case matches above case-insensitive matches', () => {
        const ranked = rankFileNameCandidates([
            file('docs/readme.md', 999),
            file('docs/README.md', 1),
        ], 'README.md')

        expect(ranked.map((entry) => entry.fullPath)).toEqual([
            'docs/README.md',
            'docs/readme.md',
        ])
    })

    it('drops folders and duplicate paths', () => {
        const ranked = rankFileNameCandidates([
            file('docs/README.md', 1),
            file('docs/README.md', 999),
            file('docs/README.md', 2, 'folder'),
        ], 'README.md')

        expect(ranked).toHaveLength(1)
    })

    it('returns nothing without a requested basename', () => {
        expect(rankFileNameCandidates([file('docs/README.md')], '')).toEqual([])
    })
})
