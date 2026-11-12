import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type UpdateMarker = {
    tag: string
    sha256: string
    binary: string
    installedAt: string
}

/**
 * Records which release was installed. The compiled binary cannot report its
 * own build tag (`--version` is the package version), so this file is the only
 * durable record for deciding whether an update is needed.
 */
export function readUpdateMarker(path: string): UpdateMarker | null {
    if (!existsSync(path)) {
        return null
    }

    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateMarker>
        if (
            typeof parsed.tag !== 'string'
            || typeof parsed.sha256 !== 'string'
            || typeof parsed.binary !== 'string'
            || typeof parsed.installedAt !== 'string'
        ) {
            return null
        }
        return {
            tag: parsed.tag,
            sha256: parsed.sha256,
            binary: parsed.binary,
            installedAt: parsed.installedAt
        }
    } catch {
        return null
    }
}

export function writeUpdateMarker(path: string, marker: UpdateMarker): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
}
