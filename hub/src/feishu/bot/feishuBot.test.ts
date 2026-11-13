import { describe, expect, it } from 'bun:test'
import { Store } from '../../store'
import { FeishuBot, formatFeishuReply } from './feishuBot'
import type { FeishuBotApi } from './feishuApi'

function fakeApi(sent: Array<{ chatId: string; text: string }>): FeishuBotApi {
    return {
        sendText: async (chatId: string, text: string) => {
            sent.push({ chatId, text })
        },
        getChatInfo: async () => null,
        getBotInfo: async () => null
    } as unknown as FeishuBotApi
}

describe('FeishuBot', () => {
    it('prefixes outbound replies with the session title', () => {
        expect(formatFeishuReply('Fix login', 'All done'))
            .toBe('会话来自：Fix login\n\nAll done')
    })

    it('sends the last assistant text when the bound session becomes ready', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'test-session',
            { name: 'Fix login', path: '/tmp' },
            {},
            'default'
        )
        store.feishuBotBindings.bind({
            chatId: 'oc_chat_1',
            chatType: 'p2p',
            chatName: null,
            namespace: 'default',
            sessionId: session.id,
            sessionTitle: 'Fix login'
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'All done' }] }
                }
            }
        })

        const sent: Array<{ chatId: string; text: string }> = []
        const bot = new FeishuBot({
            store,
            syncEngine: {} as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        await bot.sendReady({
            id: session.id,
            metadata: { name: 'Fix login' }
        } as never)

        expect(sent).toEqual([{
            chatId: 'oc_chat_1',
            text: '会话来自：Fix login\n\nAll done'
        }])
    })

    it('does not send when the session is not bound', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'test-session',
            { name: 'Unbound', path: '/tmp' },
            {},
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'All done' }] }
                }
            }
        })

        const sent: Array<{ chatId: string; text: string }> = []
        const bot = new FeishuBot({
            store,
            syncEngine: {} as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        await bot.sendReady({ id: session.id, metadata: { name: 'Unbound' } } as never)
        expect(sent).toEqual([])
    })
})
