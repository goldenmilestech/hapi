import { describe, expect, it } from 'bun:test'
import { Store } from '../../store'
import { FeishuBot, formatFeishuReply } from './feishuBot'
import type { FeishuBotApi } from './feishuApi'

type SentMessage =
    | { kind: 'text'; chatId: string; text: string }
    | { kind: 'card'; chatId: string; card: Record<string, unknown> }
    | { kind: 'card-update'; messageId: string; card: Record<string, unknown> }

function fakeApi(sent: SentMessage[]): FeishuBotApi {
    return {
        sendText: async (chatId: string, text: string) => {
            sent.push({ kind: 'text', chatId, text })
        },
        sendCard: async (chatId: string, card: unknown) => {
            sent.push({ kind: 'card', chatId, card: card as Record<string, unknown> })
            return 'om_card_1'
        },
        updateCard: async (messageId: string, card: unknown) => {
            sent.push({ kind: 'card-update', messageId, card: card as Record<string, unknown> })
        },
        getChatInfo: async () => null,
        getBotInfo: async () => null
    } as unknown as FeishuBotApi
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const startedAt = Date.now()
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('timed out waiting for condition')
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

function cardOf(message: SentMessage | undefined): Record<string, unknown> | null {
    return message && (message.kind === 'card' || message.kind === 'card-update')
        ? message.card
        : null
}

function messageEvent(
    text: string,
    eventId: string,
    messageId: string,
    options: { chatType?: 'p2p' | 'group'; mentions?: unknown[] } = {}
): string {
    return JSON.stringify({
        header: {
            event_id: eventId,
            event_type: 'im.message.receive_v1',
            token: 'token'
        },
        event: {
            sender: {
                sender_type: 'user',
                sender_id: { open_id: 'ou_alice' }
            },
            message: {
                message_id: messageId,
                chat_id: 'oc_chat_1',
                chat_type: options.chatType ?? 'p2p',
                message_type: 'text',
                content: JSON.stringify({ text }),
                ...(options.mentions ? { mentions: options.mentions } : {})
            }
        }
    })
}

function answerCardText(card: Record<string, unknown>): string | null {
    const body = card.body as { elements?: Array<{ content?: string }> } | undefined
    return body?.elements?.[0]?.content ?? null
}

function answerCardTitle(card: Record<string, unknown>): string | null {
    const header = card.header as { title?: { content?: string } } | undefined
    return header?.title?.content ?? null
}

describe('FeishuBot', () => {
    it('prefixes outbound text fallbacks with the session title', () => {
        expect(formatFeishuReply('Fix login', 'All done'))
            .toBe('会话来自：Fix login\n\nAll done')
    })

    it('sends process and markdown cards when the bound session becomes ready', async () => {
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
            role: 'user',
            content: { type: 'text', text: 'Fix the login redirect' }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'assistant-1',
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'thinking', thinking: 'Inspect the redirect first.' },
                            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/login.ts' } },
                            { type: 'text', text: 'All done' }
                        ]
                    }
                }
            }
        })

        const sent: SentMessage[] = []
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

        expect(sent).toHaveLength(2)
        expect(sent[0]?.kind).toBe('card')
        expect(sent[1]?.kind).toBe('card')
        if (sent[0]?.kind !== 'card' || sent[1]?.kind !== 'card') {
            throw new Error('expected two cards')
        }
        expect(sent[0].chatId).toBe('oc_chat_1')
        expect(JSON.stringify(sent[0].card)).toContain('Inspect the redirect first.')
        expect(answerCardTitle(sent[1].card)).toBe('会话来自：Fix login')
        expect(answerCardText(sent[1].card)).toBe('All done')

        // A duplicate ready for the same stored answer must not resend.
        await bot.sendReady({ id: session.id, metadata: { name: 'Fix login' } } as never)
        expect(sent).toHaveLength(2)
    })

    it('publishes a live process card before the answer and finalizes it in place', async () => {
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
            role: 'user',
            content: { type: 'text', text: 'Work on it' }
        })

        let listener: ((event: never) => void) | null = null
        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {
                subscribe: (fn: (event: never) => void) => {
                    listener = fn
                    return () => {
                        listener = null
                    }
                },
                getSession: () => ({
                    id: session.id,
                    thinking: true,
                    metadata: { name: 'Fix login', path: '/tmp' }
                })
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent),
            liveProgressThrottleMs: 0
        })
        const emit = () => listener?.({ type: 'message-received', sessionId: session.id } as never)

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'live-1',
                    type: 'assistant',
                    message: { content: [{ type: 'thinking', thinking: 'Live thought' }] }
                }
            }
        })
        emit()
        await waitFor(() => sent.some((message) => message.kind === 'card'))
        const liveCard = sent.find((message) => message.kind === 'card')
        expect(JSON.stringify(cardOf(liveCard))).toContain('思考过程')
        expect(JSON.stringify(cardOf(liveCard))).toContain('Live thought')

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'live-2',
                    type: 'assistant',
                    message: {
                        content: [{ type: 'tool_use', id: 'tool-live', name: 'Read', input: { file_path: '/tmp/live.ts' } }]
                    }
                }
            }
        })
        emit()
        await waitFor(() => sent.some((message) => message.kind === 'card-update'))
        expect(JSON.stringify(cardOf(sent.find((message) => message.kind === 'card-update'))))
            .toContain('Read')

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'live-answer',
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: 'Live answer' }] }
                }
            }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    resultSummary: { usage: { output_tokens: 321 }, duration_ms: 4500 }
                }
            }
        })

        await bot.sendReady({ id: session.id, metadata: { name: 'Fix login' } } as never)

        const updates = sent.filter((message) => message.kind === 'card-update')
        expect(updates.length).toBeGreaterThanOrEqual(2)
        expect(JSON.stringify(cardOf(updates.at(-1)))).toContain('321 tokens')
        // Agent Teams parity: never fall back to the provider turn duration.
        expect(JSON.stringify(cardOf(updates.at(-1)))).not.toContain('秒')
        expect(sent.filter((message) => message.kind === 'card')).toHaveLength(2)
        expect(answerCardText(cardOf(sent.at(-1)) ?? {})).toBe('Live answer')

        bot.stop()
    })

    it('shows reasoning time only after the thinking window settles', async () => {
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
            role: 'user',
            content: { type: 'text', text: 'Work on it' }
        })

        let listener: ((event: never) => void) | null = null
        const sent: SentMessage[] = []
        let clock = 1_000
        const bot = new FeishuBot({
            store,
            syncEngine: {
                subscribe: (fn: (event: never) => void) => {
                    listener = fn
                    return () => {
                        listener = null
                    }
                },
                getSession: () => ({
                    id: session.id,
                    thinking: true,
                    metadata: { name: 'Fix login', path: '/tmp' }
                })
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent),
            liveProgressThrottleMs: 0,
            now: () => clock
        })
        const emit = () => listener?.({ type: 'message-received', sessionId: session.id } as never)

        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'think-1',
                    type: 'assistant',
                    message: { content: [{ type: 'thinking', thinking: 'Plan A' }] }
                }
            }
        })
        emit()
        await waitFor(() => sent.some((message) => message.kind === 'card'))
        expect(JSON.stringify(cardOf(sent.find((message) => message.kind === 'card'))))
            .not.toContain('秒')

        clock = 9_200
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'think-1',
                    type: 'assistant',
                    message: { content: [{ type: 'thinking', thinking: 'Plan A then B' }] }
                }
            }
        })
        emit()
        await waitFor(() => sent.some((message) => message.kind === 'card-update'))
        expect(JSON.stringify(cardOf(sent.filter((message) => message.kind === 'card-update').at(-1))))
            .not.toContain('秒')

        clock = 9_400
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'tool-1',
                    type: 'assistant',
                    message: {
                        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.ts' } }]
                    }
                }
            }
        })
        emit()
        await waitFor(() => sent.filter((message) => message.kind === 'card-update').length >= 2)
        expect(JSON.stringify(cardOf(sent.filter((message) => message.kind === 'card-update').at(-1))))
            .toContain('8.2 秒')

        bot.stop()
    })

    it('does not resurrect the previous turn card when the next prompt is queued', async () => {
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
            role: 'user',
            content: { type: 'text', text: 'First request' }
        })
        store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    uuid: 'first-answer',
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'thinking', thinking: 'First thought' },
                            { type: 'text', text: 'First answer' }
                        ]
                    }
                }
            }
        })

        let listener: ((event: never) => void) | null = null
        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {
                subscribe: (fn: (event: never) => void) => {
                    listener = fn
                    return () => { listener = null }
                },
                getSession: () => ({ id: session.id, thinking: true, metadata: { name: 'Fix login', path: '/tmp' } })
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent),
            liveProgressThrottleMs: 0
        })

        await bot.sendReady({ id: session.id, metadata: { name: 'Fix login' } } as never)
        sent.length = 0
        // Simulate a hub restart: a fresh bot has no finalized-turn memory.
        const restarted = new FeishuBot({
            store,
            syncEngine: {
                subscribe: (fn: (event: never) => void) => {
                    listener = fn
                    return () => { listener = null }
                },
                getSession: () => ({ id: session.id, thinking: true, metadata: { name: 'Fix login', path: '/tmp' } })
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent),
            liveProgressThrottleMs: 0
        })
        bot.stop()

        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'Queued next request' } },
            'queued-next',
            undefined
        )
        const currentListener = listener as ((event: never) => void) | null
        currentListener?.({ type: 'message-received', sessionId: session.id } as never)
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(sent).toEqual([])
        restarted.stop()
    })

    it('forwards AskUserQuestion requests to the bound chat once', async () => {
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

        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {} as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent),
            publicUrl: 'https://hapi.test'
        })
        const pendingSession = {
            id: session.id,
            metadata: { name: 'Fix login', path: '/tmp' },
            agentState: {
                requests: {
                    'req-1': {
                        tool: 'AskUserQuestion',
                        arguments: {
                            questions: [{
                                header: 'Scope',
                                question: 'Which files?',
                                options: [{ label: 'Web' }, { label: 'Hub' }]
                            }]
                        }
                    },
                    'req-2': { tool: 'Bash', arguments: { command: 'ls' } }
                }
            }
        } as never

        await bot.sendPermissionRequest(pendingSession)
        await bot.sendPermissionRequest(pendingSession)

        const cards = sent.filter((message) => message.kind === 'card')
        expect(cards).toHaveLength(1)
        expect(JSON.stringify(cardOf(cards[0]))).toContain('Which files?')
        expect(JSON.stringify(cardOf(cards[0]))).toContain('https://hapi.test/sessions/')
        expect(JSON.stringify(cardOf(cards[0]))).not.toContain('command')
    })

    it('answers an input request from card actions and submits once', async () => {
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

        const pendingSession = {
            id: session.id,
            metadata: { name: 'Fix login', path: '/tmp' },
            agentState: {
                requests: {
                    'req-1': {
                        tool: 'AskUserQuestion',
                        arguments: {
                            questions: [{
                                header: 'Scope',
                                question: 'Which files?',
                                multiSelect: true,
                                options: [{ label: 'Web' }, { label: 'Hub' }]
                            }]
                        }
                    }
                }
            }
        }
        const calls: unknown[][] = []
        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {
                getSession: () => pendingSession,
                approvePermission: async (...args: unknown[]) => {
                    calls.push(args)
                }
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent),
            publicUrl: 'https://hapi.test'
        })

        await bot.sendPermissionRequest(pendingSession as never)
        expect(sent.filter((message) => message.kind === 'card')).toHaveLength(1)

        const toggle = await bot.handleWebhook(JSON.stringify({
            schema: '2.0',
            header: { event_id: 'evt-toggle', event_type: 'card.action.trigger', token: 'token' },
            event: {
                operator: { open_id: 'ou_1' },
                action: {
                    tag: 'checker',
                    checked: true,
                    value: {
                        kind: 'hapi_input',
                        action: 'toggle',
                        sessionId: session.id,
                        requestId: 'req-1',
                        question: 0,
                        value: 'Web'
                    }
                },
                context: { open_message_id: 'om_card_1', open_chat_id: 'oc_chat_1' }
            }
        }), new Headers())
        const toggleResponse = toggle && 'response' in toggle ? toggle.response : null
        expect(JSON.stringify(toggleResponse?.card)).toContain('"checked":true')
        expect(calls).toHaveLength(0)

        const submit = await bot.handleWebhook(JSON.stringify({
            schema: '2.0',
            header: { event_id: 'evt-submit', event_type: 'card.action.trigger', token: 'token' },
            event: {
                operator: { open_id: 'ou_1' },
                action: {
                    tag: 'button',
                    value: {
                        kind: 'hapi_input',
                        action: 'submit',
                        sessionId: session.id,
                        requestId: 'req-1'
                    }
                },
                context: { open_message_id: 'om_card_1', open_chat_id: 'oc_chat_1' }
            }
        }), new Headers())
        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual([session.id, 'req-1', undefined, undefined, undefined, { '0': ['Web'] }])
        const submitResponse = submit && 'response' in submit ? submit.response : null
        expect(submitResponse?.toast?.content).toContain('已提交')
        expect(JSON.stringify(submitResponse?.card)).toContain('已回答')
    })

    it('reports an expired card when the request was already answered in Hapi', async () => {
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

        const pendingSession = {
            id: session.id,
            metadata: { name: 'Fix login', path: '/tmp' },
            agentState: {
                requests: {
                    'req-1': {
                        tool: 'AskUserQuestion',
                        arguments: {
                            questions: [{
                                question: 'Which files?',
                                options: [{ label: 'Web' }]
                            }]
                        }
                    }
                }
            }
        }
        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {
                getSession: () => pendingSession,
                approvePermission: async () => {}
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        await bot.sendPermissionRequest(pendingSession as never)
        // Answer it in the Hapi web UI: the request disappears from agent state.
        pendingSession.agentState.requests = {} as never

        const submit = await bot.handleWebhook(JSON.stringify({
            schema: '2.0',
            header: { event_id: 'evt-late', event_type: 'card.action.trigger', token: 'token' },
            event: {
                operator: { open_id: 'ou_1' },
                action: {
                    tag: 'button',
                    value: {
                        kind: 'hapi_input',
                        action: 'submit',
                        sessionId: session.id,
                        requestId: 'req-1'
                    }
                },
                context: { open_message_id: 'om_card_1', open_chat_id: 'oc_chat_1' }
            }
        }), new Headers())

        const response = submit && 'response' in submit ? submit.response : null
        expect(response?.toast?.content).toContain('已失效')
        expect(JSON.stringify(response?.card)).toContain('问题已失效')
    })

    it('settles a tracked question card when it is skipped in the Hapi UI', async () => {
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

        const pendingSession = {
            id: session.id,
            thinking: false,
            metadata: { name: 'Fix login', path: '/tmp' },
            agentState: {
                requests: {
                    'req-1': {
                        tool: 'AskUserQuestion',
                        arguments: {
                            questions: [{
                                question: 'Which files?',
                                options: [{ label: 'Web' }]
                            }]
                        }
                    }
                }
            }
        }

        let listener: ((event: never) => void) | null = null
        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {
                subscribe: (fn: (event: never) => void) => {
                    listener = fn
                    return () => {
                        listener = null
                    }
                },
                getSession: () => pendingSession
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        await bot.sendPermissionRequest(pendingSession as never)
        expect(sent.filter((message) => message.kind === 'card')).toHaveLength(1)

        // The operator clicks Skip in the Hapi web UI: the request disappears
        // from agent state without any Feishu card action.
        pendingSession.agentState.requests = {} as never
        const currentListener = listener as ((event: never) => void) | null
        currentListener?.({ type: 'session-updated', sessionId: session.id } as never)

        await waitFor(() => sent.some((message) => message.kind === 'card-update'))
        expect(JSON.stringify(cardOf(sent.find((message) => message.kind === 'card-update'))))
            .toContain('问题已失效')
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

        const sent: SentMessage[] = []
        const bot = new FeishuBot({
            store,
            syncEngine: {} as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        await bot.sendReady({ id: session.id, metadata: { name: 'Unbound' } } as never)
        expect(sent).toEqual([])
    })

    it('forwards ordinary 1:1 chat but leaves group chatter to the Manager', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'test-session',
            { name: 'Manager', path: '/tmp' },
            {},
            'default'
        )
        store.feishuBotBindings.bind({
            chatId: 'oc_chat_1',
            chatType: 'p2p',
            chatName: null,
            namespace: 'default',
            sessionId: session.id,
            sessionTitle: 'Manager'
        })

        const sent: SentMessage[] = []
        const forwarded: Array<{ sessionId: string; text: string; localId?: string | null }> = []
        const bot = new FeishuBot({
            store,
            syncEngine: {
                getSession: () => ({
                    id: session.id,
                    active: true,
                    metadata: { name: 'Manager', path: '/tmp' }
                }),
                sendMessage: async (sessionId: string, payload: { text: string; localId?: string | null }) => {
                    forwarded.push({ sessionId, text: payload.text, localId: payload.localId })
                }
            } as never,
            config: { appId: 'app', appSecret: 'secret', verificationToken: 'token', encryptKey: null },
            api: fakeApi(sent)
        })

        // A 1:1 chat has no Manager bot listening, so ordinary text still
        // reaches the bound session.
        await bot.handleWebhook(messageEvent('普通聊天', 'evt-1', 'om_1'), new Headers())
        expect(forwarded).toEqual([{
            sessionId: session.id,
            text: '普通聊天',
            localId: 'feishu:om_1'
        }])
        expect(sent).toEqual([])

        // Group chatter goes to the Manager bot; the Hapi plugin stays silent.
        await bot.handleWebhook(
            messageEvent('群聊闲聊', 'evt-g1', 'om_g1', { chatType: 'group' }),
            new Headers()
        )
        expect(forwarded).toHaveLength(1)
        expect(sent).toEqual([])

        // A /hapi command in a group is addressed to the plugin.
        await bot.handleWebhook(messageEvent(
            '@_user_1 /hapi 清理一下',
            'evt-g2',
            'om_g2',
            {
                chatType: 'group',
                mentions: [{
                    key: '@_user_1',
                    name: 'Hapi',
                    mentioned_type: 'app',
                    id: { open_id: 'cli_bot' }
                }]
            }
        ), new Headers())
        expect(forwarded).toHaveLength(2)
        expect(forwarded[1]).toMatchObject({
            sessionId: session.id,
            text: '清理一下',
            localId: 'feishu:om_g2'
        })
        expect(sent).toEqual([])

        await bot.handleWebhook(messageEvent('/hapi', 'evt-3', 'om_3'), new Headers())
        expect(forwarded).toHaveLength(2)
        expect(sent[0]).toMatchObject({ kind: 'text', chatId: 'oc_chat_1' })
        expect((sent[0] as { kind: 'text'; text: string }).text).toContain('/hapi <消息>')
    })
})
