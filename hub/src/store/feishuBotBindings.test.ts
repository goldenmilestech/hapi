import { describe, expect, it } from 'bun:test'
import { Store } from './index'

function bindFixture(store: Store) {
    return store.feishuBotBindings.bind({
        chatId: 'oc_chat_1',
        chatType: 'p2p',
        chatName: 'Alice DM',
        namespace: 'default',
        sessionId: 'session-1',
        sessionTitle: 'Fix the login bug'
    })
}

describe('FeishuBotBindingStore', () => {
    it('binds a chat to a session and exposes both lookup directions', () => {
        const store = new Store(':memory:')
        const binding = bindFixture(store)

        expect(binding.chatId).toBe('oc_chat_1')
        expect(store.feishuBotBindings.getByChatId('oc_chat_1')?.sessionId).toBe('session-1')
        expect(store.feishuBotBindings.getBySessionId('session-1')?.chatId).toBe('oc_chat_1')
        expect(store.feishuBotBindings.getSessionIdsByNamespace('default')).toEqual(new Set(['session-1']))
    })

    it('keeps binding 1:1 by moving either side when it is rebound', () => {
        const store = new Store(':memory:')
        bindFixture(store)

        store.feishuBotBindings.bind({
            chatId: 'oc_chat_1',
            chatType: 'group',
            chatName: 'Team',
            namespace: 'default',
            sessionId: 'session-2',
            sessionTitle: 'Second session'
        })
        expect(store.feishuBotBindings.listByNamespace('default')).toHaveLength(1)
        expect(store.feishuBotBindings.getBySessionId('session-1')).toBeNull()

        store.feishuBotBindings.bind({
            chatId: 'oc_chat_3',
            chatType: 'p2p',
            chatName: null,
            namespace: 'default',
            sessionId: 'session-2',
            sessionTitle: 'Second session'
        })
        expect(store.feishuBotBindings.listByNamespace('default')).toHaveLength(1)
        expect(store.feishuBotBindings.getByChatId('oc_chat_1')).toBeNull()
        expect(store.feishuBotBindings.getByChatId('oc_chat_3')?.sessionId).toBe('session-2')
    })

    it('scopes listings and deletes by namespace', () => {
        const store = new Store(':memory:')
        bindFixture(store)
        store.feishuBotBindings.bind({
            chatId: 'oc_chat_2',
            chatType: 'p2p',
            chatName: null,
            namespace: 'alice',
            sessionId: 'session-a',
            sessionTitle: 'Alice work'
        })

        expect(store.feishuBotBindings.listByNamespace('default')).toHaveLength(1)
        expect(store.feishuBotBindings.listByNamespace('alice')).toHaveLength(1)
        const binding = store.feishuBotBindings.getByChatId('oc_chat_2')!
        expect(store.feishuBotBindings.removeById(binding.id, 'default')).toBe(false)
        expect(store.feishuBotBindings.removeById(binding.id, 'alice')).toBe(true)
    })

    it('consumes a bind code exactly once and rejects expired codes', () => {
        const store = new Store(':memory:')
        const now = 1_000_000
        const { code, expiresAt } = store.feishuBotBindings.createBindCode(
            { namespace: 'default', sessionId: 'session-1' },
            now
        )

        expect(store.feishuBotBindings.consumeBindCode(code.toLowerCase(), now + 1)).toEqual({
            namespace: 'default',
            sessionId: 'session-1'
        })
        expect(store.feishuBotBindings.consumeBindCode(code, now + 2)).toBeNull()

        const expired = store.feishuBotBindings.createBindCode(
            { namespace: 'default', sessionId: 'session-2' },
            now
        )
        expect(store.feishuBotBindings.consumeBindCode(expired.code, expiresAt + 1)).toBeNull()
    })

    it('records events for de-duplication only when asked', () => {
        const store = new Store(':memory:')
        expect(store.feishuBotBindings.hasEvent('evt-1')).toBe(false)
        store.feishuBotBindings.recordEvent('evt-1')
        expect(store.feishuBotBindings.hasEvent('evt-1')).toBe(true)
    })
})
