import { createHash } from 'node:crypto'
import type { Store } from '../store'
import type { FeishuUserInfo } from './feishuOAuth'

export type FeishuIdentityConfig = {
    ownerOpenId: string | null
    ownerEmail: string | null
}

/**
 * Pre-binding an email to a namespace that another Feishu account already
 * uses would silently merge two people. Fail the login and let the owner fix
 * the binding instead.
 */
export class FeishuNamespaceConflictError extends Error {
    constructor(public readonly namespace: string) {
        super(`Namespace already mapped to another Feishu user: ${namespace}`)
        this.name = 'FeishuNamespaceConflictError'
    }
}

/**
 * Stable, opaque namespace for a Feishu user. Deriving it from open_id keeps
 * it unchanged across renames and email changes, and does not expose the ID.
 */
export function autoFeishuNamespace(openId: string): string {
    return `fs_${createHash('sha256').update(openId, 'utf8').digest('hex').slice(0, 16)}`
}

function normalizeEmail(email: string | null | undefined): string | null {
    const trimmed = email?.trim().toLowerCase()
    return trimmed ? trimmed : null
}

export function matchOwnerNamespace(user: FeishuUserInfo, config: FeishuIdentityConfig): string | null {
    if (config.ownerOpenId && user.openId === config.ownerOpenId) {
        return 'default'
    }
    const ownerEmail = normalizeEmail(config.ownerEmail)
    if (ownerEmail) {
        if (normalizeEmail(user.email) === ownerEmail || normalizeEmail(user.enterpriseEmail) === ownerEmail) {
            return 'default'
        }
    }
    return null
}

/**
 * Resolution order:
 *   1. the configured owner open_id / email → `default` (can promote an
 *      existing user when the operator adds them later)
 *   2. an existing Feishu user row (open_id)
 *   3. an owner-created email binding → that namespace
 *   4. a new opaque `fs_<hash>` namespace
 */
export function resolveFeishuNamespace(
    store: Store,
    config: FeishuIdentityConfig,
    user: FeishuUserInfo
): string {
    const ownerNamespace = matchOwnerNamespace(user, config)
    if (ownerNamespace) {
        // Upsert: adding the owner env later must move an existing user.
        store.users.addUser('feishu', user.openId, ownerNamespace)
        return ownerNamespace
    }

    const existing = store.users.getUser('feishu', user.openId)
    if (existing) {
        return existing.namespace
    }

    const email = normalizeEmail(user.email) ?? normalizeEmail(user.enterpriseEmail)
    if (email) {
        const binding = store.feishuBindings.getByEmail(email)
        if (binding) {
            const mapped = store.users.getUsersByPlatformAndNamespace('feishu', binding.namespace)
            if (mapped.some((row) => row.platformUserId !== user.openId)) {
                throw new FeishuNamespaceConflictError(binding.namespace)
            }
            store.users.addUser('feishu', user.openId, binding.namespace)
            return binding.namespace
        }
    }

    const namespace = autoFeishuNamespace(user.openId)
    const mapped = store.users.getUsersByPlatformAndNamespace('feishu', namespace)
    if (mapped.some((row) => row.platformUserId !== user.openId)) {
        throw new FeishuNamespaceConflictError(namespace)
    }
    store.users.addUser('feishu', user.openId, namespace)
    return namespace
}
