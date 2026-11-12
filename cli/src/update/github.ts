import { selectLatestCliRelease, type ReleaseSummary } from './release'

const GITHUB_API = 'https://api.github.com'
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 30_000

export type FetchImpl = typeof fetch

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function githubFetch(
    url: string,
    init: RequestInit,
    fetchImpl: FetchImpl
): Promise<Response> {
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetchImpl(url, {
                ...init,
                headers: {
                    'User-Agent': 'hapi-cli-update',
                    Accept: 'application/vnd.github+json',
                    ...(init.headers as Record<string, string> | undefined)
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            })

            if (response.status === 403 || response.status === 429) {
                const remaining = response.headers.get('x-ratelimit-remaining')
                if (remaining === '0') {
                    throw new Error(
                        'GitHub API rate limit reached. Retry later, or pin a release with --tag <tag>.'
                    )
                }
            }
            if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
                lastError = new Error(`GitHub API returned HTTP ${response.status}`)
                await sleep(attempt * 1_000)
                continue
            }
            return response
        } catch (error) {
            lastError = error
            if (attempt < MAX_ATTEMPTS) {
                await sleep(attempt * 1_000)
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

export async function fetchLatestRelease(repo: string, fetchImpl: FetchImpl): Promise<ReleaseSummary> {
    const response = await githubFetch(`${GITHUB_API}/repos/${repo}/releases?per_page=30`, {}, fetchImpl)
    if (!response.ok) {
        throw new Error(`Cannot list releases for ${repo}: HTTP ${response.status}`)
    }

    const latest = selectLatestCliRelease(await response.json())
    if (!latest) {
        throw new Error(`No cli-* release found for ${repo}`)
    }
    return latest
}

export type ReleaseAsset = {
    id: number
    name: string
    size: number | null
}

export async function fetchReleaseAsset(
    repo: string,
    tag: string,
    name: string,
    fetchImpl: FetchImpl
): Promise<ReleaseAsset> {
    const response = await githubFetch(
        `${GITHUB_API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
        {},
        fetchImpl
    )
    if (!response.ok) {
        throw new Error(`Cannot read release ${tag}: HTTP ${response.status}`)
    }

    const payload = await response.json() as { assets?: unknown }
    const assets = Array.isArray(payload.assets) ? payload.assets : []
    const asset = assets.find((item): item is { id: number; name: string; size?: number } => (
        Boolean(item)
        && typeof item === 'object'
        && Number.isInteger((item as { id?: unknown }).id)
        && (item as { name?: unknown }).name === name
    ))
    if (!asset) {
        throw new Error(`Release ${tag} has no asset named ${name}`)
    }

    return {
        id: asset.id,
        name,
        size: typeof asset.size === 'number' ? asset.size : null
    }
}

export async function downloadAsset(
    repo: string,
    assetId: number,
    fetchImpl: FetchImpl
): Promise<Uint8Array> {
    const response = await githubFetch(
        `${GITHUB_API}/repos/${repo}/releases/assets/${assetId}`,
        { headers: { Accept: 'application/octet-stream' } },
        fetchImpl
    )
    if (!response.ok) {
        throw new Error(`Cannot download release asset ${assetId}: HTTP ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
}
