export type ArchiveKind = 'tar.gz' | 'zip'

export type UpdateTarget = {
    platform: 'darwin' | 'linux' | 'win32'
    arch: 'arm64' | 'x64'
    asset: string
    archiveKind: ArchiveKind
    binaryName: string
}

/**
 * Maps the running platform to the asset name produced by the fork's
 * `cli-release.yml` workflow. Linux x64 is published as `-baseline` because
 * the hub host may lack AVX2.
 */
export function resolveUpdateTarget(
    platform: string = process.platform,
    arch: string = process.arch
): UpdateTarget {
    if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
        return {
            platform,
            arch,
            asset: `hapi-darwin-${arch}.tar.gz`,
            archiveKind: 'tar.gz',
            binaryName: 'hapi'
        }
    }
    if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
        return {
            platform,
            arch,
            asset: arch === 'x64' ? 'hapi-linux-x64-baseline.tar.gz' : 'hapi-linux-arm64.tar.gz',
            archiveKind: 'tar.gz',
            binaryName: 'hapi'
        }
    }
    if (platform === 'win32' && arch === 'x64') {
        return {
            platform,
            arch,
            asset: 'hapi-win32-x64.zip',
            archiveKind: 'zip',
            binaryName: 'hapi.exe'
        }
    }
    throw new Error(`Unsupported platform: ${platform}-${arch}`)
}

export type ReleaseSummary = {
    tag: string
    publishedAt: string | null
}

type RawRelease = {
    tag_name?: unknown
    draft?: unknown
    published_at?: unknown
    created_at?: unknown
}

function isRawRelease(value: unknown): value is RawRelease {
    return Boolean(value) && typeof value === 'object'
}

/**
 * Picks the newest non-draft `cli-*` release by publish time.
 *
 * The GitHub releases endpoint does not guarantee ordering, and every fork
 * release is a prerelease, so `/releases/latest` cannot be used.
 */
export function selectLatestCliRelease(payload: unknown): ReleaseSummary | null {
    if (!Array.isArray(payload)) {
        return null
    }

    const candidates = payload
        .filter(isRawRelease)
        .filter((release) => (
            release.draft !== true
            && typeof release.tag_name === 'string'
            && release.tag_name.startsWith('cli-')
        ))
        .map((release) => ({
            tag: release.tag_name as string,
            publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
            sortAt: Date.parse(
                typeof release.published_at === 'string'
                    ? release.published_at
                    : typeof release.created_at === 'string' ? release.created_at : ''
            ) || 0
        }))
        .sort((left, right) => right.sortAt - left.sortAt)

    const latest = candidates[0]
    return latest ? { tag: latest.tag, publishedAt: latest.publishedAt } : null
}

/**
 * Parses `sha256sum` output into asset name -> lowercase digest.
 */
export function parseChecksums(text: string): Map<string, string> {
    const checksums = new Map<string, string>()
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/i)
        if (!match) {
            continue
        }
        checksums.set(match[2], match[1].toLowerCase())
    }
    return checksums
}
