import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function block(input: unknown, options: {
    name?: string
    state?: ToolCallBlock['tool']['state']
    result?: unknown
    permission?: ToolCallBlock['tool']['permission']
} = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'feishu-1',
        localId: null,
        createdAt: 1000,
        children: [],
        tool: {
            id: 'feishu-1',
            name: options.name ?? 'feishu_send_message',
            state: options.state ?? 'completed',
            input,
            result: options.result,
            description: null,
            createdAt: 1000,
            startedAt: 1000,
            completedAt: 1500,
            execStartedAt: null,
            execCompletedAt: null,
            permission: options.permission
        }
    }
}

function renderCard(blockValue: ToolCallBlock) {
    return render(
        <I18nProvider>
            <ToolCard
                api={{} as ApiClient}
                sessionId="session-1"
                metadata={null}
                terminalToolDisplayMode="detailed"
                disabled={false}
                onDone={() => {}}
                block={blockValue}
            />
        </I18nProvider>
    )
}

describe('Feishu send cards', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

    it('renders the executed MCP tool with its recipient and text', () => {
        renderCard(block(
            { kind: 'dm', to: 'ou_guest', text: 'hello guest' },
            {
                name: 'mcp__hapi__feishu_send_message',
                result: '飞书消息已发送给 张三（guest@corp.com）（message_id=om_1）。'
            }
        ))
        expect(screen.getByText('Feishu message')).toBeInTheDocument()
        expect(screen.getAllByText('hello guest').length).toBeGreaterThan(0)
        expect(screen.getAllByText('ou_guest').length).toBeGreaterThan(0)
    })

    it('renders a pending group approval with sender and one-time actions', () => {
        renderCard(block(
            {
                requestId: 'feishu:test',
                kind: 'group',
                targetLabel: '项目群（oc_project）',
                senderLabel: '董卓然',
                text: 'deploy done\n\n—— 由 <at user_id="ou_owner"></at> 通过 HAPI 发送',
                preview: 'deploy done',
                expiresAt: Date.now() + 600_000
            },
            {
                state: 'pending',
                permission: { id: 'feishu:test', status: 'pending' }
            }
        ))
        expect(screen.getByText('Feishu send approval')).toBeInTheDocument()
        expect(screen.getByText('Group')).toBeInTheDocument()
        expect(screen.getAllByText('项目群（oc_project）').length).toBeGreaterThan(0)
        expect(screen.getAllByText('董卓然').length).toBeGreaterThan(0)
        expect(screen.getByRole('button', { name: 'Approve and send' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Allow For Session' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Allow All Edits' })).not.toBeInTheDocument()
    })

    it('shows the receipt after a completed approval', () => {
        renderCard(block(
            {
                requestId: 'feishu:test',
                kind: 'dm',
                targetLabel: '张三（guest@corp.com）',
                senderLabel: '董卓然',
                text: 'hello',
                preview: 'hello',
                expiresAt: Date.now() + 600_000
            },
            {
                permission: {
                    id: 'feishu:test',
                    status: 'approved',
                    reason: '已发送 · message_id=om_1'
                }
            }
        ))
        expect(screen.getByText(/Receipt: 已发送 · message_id=om_1/)).toBeInTheDocument()
    })
})
