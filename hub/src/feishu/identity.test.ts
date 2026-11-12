import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import {
    autoFeishuNamespace,
    FeishuNamespaceConflictError,
    matchOwnerNamespace,
    resolveFeishuNamespace
} from './identity'
import type { FeishuUserInfo } from './feishuOAuth'

function user(overrides: Partial<FeishuUserInfo> = {}): FeishuUserInfo {
    return {
        openId: 'ou_alice',
        unionId: null,
        userId: null,
        name: 'Alice',
        email: 'alice@corp.com',
        enterpriseEmail: null,
        avatarUrl: null,
        ...overrides
    }
}

const noOwner = { ownerOpenId: null, ownerEmail: null }

describe('Feishu identity mapping', () => {
    it('derives a stable opaque namespace from open_id', () => {
        const first = autoFeishuNamespace('ou_alice')
        expect(first).toBe(autoFeishuNamespace('ou_alice'))
        expect(first.startsWith('fs_')).toBe(true)
        expect(first).toHaveLength(19)
        expect(first).not.toContain('ou_alice')
        expect(autoFeishuNamespace('ou_bob')).not.toBe(first)
    })

    it('maps the configured owner to default by open_id or email', () => {
        expect(matchOwnerNamespace(user(), { ownerOpenId: 'ou_alice', ownerEmail: null })).toBe('default')
        expect(matchOwnerNamespace(user(), { ownerOpenId: null, ownerEmail: 'ALICE@corp.com' })).toBe('default')
        expect(matchOwnerNamespace(
            user({ email: null, enterpriseEmail: 'Alice@Corp.com' }),
            { ownerOpenId: null, ownerEmail: 'alice@corp.com' }
        )).toBe('default')
        expect(matchOwnerNamespace(user(), { ownerOpenId: 'ou_other', ownerEmail: 'other@corp.com' })).toBeNull()
    })

    it('allocates and persists a new namespace on first login', () => {
        const store = new Store(':memory:')
        const namespace = resolveFeishuNamespace(store, noOwner, user())

        expect(namespace).toBe(autoFeishuNamespace('ou_alice'))
        expect(store.users.getUser('feishu', 'ou_alice')?.namespace).toBe(namespace)

        // A second login keeps the same namespace.
        expect(resolveFeishuNamespace(store, noOwner, user())).toBe(namespace)

        store.close()
    })

    it('promotes an existing user when the owner env is added later', () => {
        const store = new Store(':memory:')
        const first = resolveFeishuNamespace(store, noOwner, user())
        expect(first).toBe(autoFeishuNamespace('ou_alice'))

        const promoted = resolveFeishuNamespace(
            store,
            { ownerOpenId: 'ou_alice', ownerEmail: null },
            user()
        )
        expect(promoted).toBe('default')
        expect(store.users.getUser('feishu', 'ou_alice')?.namespace).toBe('default')

        store.close()
    })

    it('wins owner over an existing email binding', () => {
        const store = new Store(':memory:')
        store.feishuBindings.upsert({ email: 'alice@corp.com', namespace: 'legacy-alice' })

        const namespace = resolveFeishuNamespace(
            store,
            { ownerOpenId: 'ou_alice', ownerEmail: null },
            user()
        )
        expect(namespace).toBe('default')

        store.close()
    })

    it('binds an email to an existing namespace exactly once', () => {
        const store = new Store(':memory:')
        store.feishuBindings.upsert({ email: 'alice@corp.com', namespace: 'legacy-alice' })

        const namespace = resolveFeishuNamespace(store, noOwner, user())
        expect(namespace).toBe('legacy-alice')
        expect(store.users.getUser('feishu', 'ou_alice')?.namespace).toBe('legacy-alice')

        // A second account bound to the same namespace is rejected instead of
        // silently sharing another person's sessions.
        store.feishuBindings.upsert({ email: 'bob@corp.com', namespace: 'legacy-alice' })
        expect(() => resolveFeishuNamespace(
            store,
            noOwner,
            user({ openId: 'ou_bob', email: 'bob@corp.com', name: 'Bob' })
        )).toThrow(FeishuNamespaceConflictError)

        store.close()
    })

    it('uses enterprise_email when email is absent', () => {
        const store = new Store(':memory:')
        store.feishuBindings.upsert({ email: 'alice@corp.com', namespace: 'legacy-alice' })

        const namespace = resolveFeishuNamespace(
            store,
            noOwner,
            user({ email: null, enterpriseEmail: 'Alice@Corp.com' })
        )
        expect(namespace).toBe('legacy-alice')

        store.close()
    })
})
