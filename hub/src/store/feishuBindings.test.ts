import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { normalizeFeishuEmail } from './feishuBindings'

describe('FeishuBindingStore', () => {
    it('normalizes emails and upserts bindings', () => {
        const store = new Store(':memory:')

        const created = store.feishuBindings.upsert({
            email: '  Alice@Corp.com ',
            namespace: 'legacy-alice'
        })
        expect(created.email).toBe('alice@corp.com')
        expect(created.namespace).toBe('legacy-alice')

        // Re-binding the same email updates the namespace instead of failing.
        const updated = store.feishuBindings.upsert({
            email: 'alice@corp.com',
            namespace: 'alice-2'
        })
        expect(updated.id).toBe(created.id)
        expect(updated.namespace).toBe('alice-2')

        expect(store.feishuBindings.getByEmail('ALICE@corp.com')?.namespace).toBe('alice-2')
        expect(store.feishuBindings.list()).toHaveLength(1)

        store.close()
    })

    it('removes bindings and rejects invalid input', () => {
        const store = new Store(':memory:')
        store.feishuBindings.upsert({ email: 'bob@corp.com', namespace: 'bob' })

        expect(store.feishuBindings.remove('BOB@corp.com')).toBe(true)
        expect(store.feishuBindings.remove('bob@corp.com')).toBe(false)
        expect(store.feishuBindings.getByEmail('bob@corp.com')).toBeNull()

        expect(() => store.feishuBindings.upsert({ email: '', namespace: 'x' })).toThrow()
        expect(() => store.feishuBindings.upsert({ email: 'x@corp.com', namespace: 'has:colon' })).toThrow()

        store.close()
    })

    it('normalizes whitespace and case only', () => {
        expect(normalizeFeishuEmail('  A@B.COM ')).toBe('a@b.com')
        expect(normalizeFeishuEmail('   ')).toBe('')
    })
})
