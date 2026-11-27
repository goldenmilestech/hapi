import type { FileSearchItem } from '@/types/api'

/**
 * Chat autolinks treat bare file names (`proposal.md`) as workspace-relative
 * paths, so a name that only exists in a subdirectory opens a dead file route
 * whose runner read fails with ENOENT. These helpers let the file page recover
 * by locating same-name files inside the session workspace.
 */

export function isMissingFileError(error: string | null | undefined): boolean {
    if (!error) return false
    return /\bENOENT\b/i.test(error) || /no such file or directory/i.test(error)
}

export function fileNameOf(path: string): string {
    const normalized = path.trim().replace(/\\/g, '/')
    const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
    const slash = trimmed.lastIndexOf('/')
    return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

export function isAbsoluteFilePath(path: string): boolean {
    return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function normalizePath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Number of trailing path segments shared with the requested path. A bare
 * requested name scores 0; `docs/README.md` prefers `.../docs/README.md` over
 * `.../other/README.md`.
 */
function trailingSegmentMatchLength(candidatePath: string, requestedPath: string): number {
    const requested = normalizePath(requestedPath)
    if (isAbsoluteFilePath(requested) || !requested.includes('/')) return 0

    const requestedSegments = requested.split('/').filter(Boolean)
    const candidateSegments = normalizePath(candidatePath).split('/').filter(Boolean)
    let matched = 0
    let requestIndex = requestedSegments.length - 1
    let candidateIndex = candidateSegments.length - 1
    while (requestIndex >= 0 && candidateIndex >= 0) {
        if (requestedSegments[requestIndex] !== candidateSegments[candidateIndex]) break
        matched++
        requestIndex--
        candidateIndex--
    }
    return matched
}

/**
 * Keep files whose basename matches the requested name and rank them so the
 * most likely target comes first: exact case, then deepest shared directory
 * suffix, then most recently modified, then path order.
 */
export function rankFileNameCandidates(
    files: readonly FileSearchItem[],
    requestedPath: string
): FileSearchItem[] {
    const requestedName = fileNameOf(requestedPath)
    if (!requestedName) return []
    const requestedNameLower = requestedName.toLowerCase()

    const seen = new Set<string>()
    const ranked: Array<{
        item: FileSearchItem
        exactCase: number
        suffix: number
        modified: number
    }> = []

    for (const file of files) {
        if (!file || file.fileType !== 'file' || !file.fullPath) continue
        if (seen.has(file.fullPath)) continue
        const candidateName = fileNameOf(file.fullPath)
        const exactCase = candidateName === requestedName
        if (!exactCase && candidateName.toLowerCase() !== requestedNameLower) continue
        seen.add(file.fullPath)
        ranked.push({
            item: file,
            exactCase: exactCase ? 1 : 0,
            suffix: trailingSegmentMatchLength(file.fullPath, requestedPath),
            modified: typeof file.modified === 'number' && Number.isFinite(file.modified)
                ? file.modified
                : 0
        })
    }

    ranked.sort((a, b) => {
        if (a.exactCase !== b.exactCase) return b.exactCase - a.exactCase
        if (a.suffix !== b.suffix) return b.suffix - a.suffix
        if (a.modified !== b.modified) return b.modified - a.modified
        return a.item.fullPath.localeCompare(b.item.fullPath)
    })

    return ranked.map((entry) => entry.item)
}
