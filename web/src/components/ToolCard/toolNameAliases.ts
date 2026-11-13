/**
 * Flavor-specific tool ids (OpenCode reports its built-ins by lowercase id)
 * resolved to the canonical presentation names, shared by every presentation
 * path. Identity for any name not listed.
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
    bash: 'Bash',
    glob: 'Glob',
    grep: 'Grep',
    list: 'LS',
    write: 'Write',
    edit: 'Edit',
    webfetch: 'WebFetch',
    websearch: 'WebSearch',
    task: 'Task',
    // Agent-initiated Feishu sends: the pending approval is synthesized from
    // agentState.requests under the bare name, while the executed tool arrives
    // from MCP with the mcp__hapi__ prefix. Both render the same card.
    feishu_send_message: 'FeishuSendMessage',
    'mcp__hapi__feishu_send_message': 'FeishuSendMessage',
    hapi__feishu_send_message: 'FeishuSendMessage',
    hapi_feishu_send_message: 'FeishuSendMessage',
    feishu_send_status: 'FeishuSendStatus',
    'mcp__hapi__feishu_send_status': 'FeishuSendStatus',
    hapi__feishu_send_status: 'FeishuSendStatus',
    hapi_feishu_send_status: 'FeishuSendStatus'
}

// Canonical name for a flavor-specific tool id, or the input unchanged.
export function resolveToolNameAlias(toolName: string): string {
    return Object.hasOwn(TOOL_NAME_ALIASES, toolName) ? TOOL_NAME_ALIASES[toolName] : toolName
}