import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const VS_CODE_APP_NAME = 'Visual Studio Code'
const LAUNCH_TIMEOUT_MS = 15_000

export type OpenWorkspaceLaunchCommand = {
    command: string
    args: string[]
}

export type OpenWorkspaceResult =
    | { success: true }
    | { success: false; error: string }

type OpenWorkspaceRunner = (command: OpenWorkspaceLaunchCommand) => Promise<void>

/**
 * Ordered launch attempts for the host platform. macOS prefers `open -a` so it
 * works without the `code` shell shim being installed; the CLI fallback covers
 * machines where LaunchServices cannot resolve the app name.
 */
export function buildOpenWorkspaceCommands(
    directory: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env
): OpenWorkspaceLaunchCommand[] {
    if (platform === 'darwin') {
        return [
            { command: 'open', args: ['-a', VS_CODE_APP_NAME, directory] },
            { command: 'code', args: [directory] },
        ]
    }
    if (platform === 'win32') {
        // Launch Code.exe directly instead of going through code.cmd: cmd.exe
        // re-parses the directory and would give workspace path characters
        // command-line meaning.
        const candidates: string[] = []
        if (env.LOCALAPPDATA) {
            candidates.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'))
        }
        for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
            if (root) {
                candidates.push(win32.join(root, 'Microsoft VS Code', 'Code.exe'))
            }
        }
        // PATH lookup for portable/scooped installs; CreateProcess resolves it
        // without a shell.
        candidates.push('Code.exe')
        return candidates.map((command) => ({ command, args: [directory] }))
    }
    return [{ command: 'code', args: [directory] }]
}

function formatLaunchError(command: OpenWorkspaceLaunchCommand, error: unknown): string {
    if (error && typeof error === 'object') {
        const stderr = (error as { stderr?: unknown }).stderr
        if (typeof stderr === 'string' && stderr.trim()) {
            return stderr.trim()
        }
    }
    if (error instanceof Error && error.message.trim()) {
        return error.message.trim()
    }
    return `${command.command} failed to launch`
}

async function defaultRunCommand(command: OpenWorkspaceLaunchCommand): Promise<void> {
    await execFileAsync(command.command, command.args, {
        timeout: LAUNCH_TIMEOUT_MS,
        windowsHide: true,
    })
}

export async function openWorkspaceInEditor(
    directory: string,
    deps?: {
        platform?: NodeJS.Platform
        runCommand?: OpenWorkspaceRunner
    }
): Promise<OpenWorkspaceResult> {
    const commands = buildOpenWorkspaceCommands(
        directory,
        deps?.platform ?? process.platform
    )
    const runCommand = deps?.runCommand ?? defaultRunCommand
    const failures: string[] = []

    for (const command of commands) {
        try {
            await runCommand(command)
            return { success: true }
        } catch (error) {
            failures.push(formatLaunchError(command, error))
        }
    }

    return {
        success: false,
        error: failures.length > 0 ? failures.join('; ') : 'Failed to launch VS Code',
    }
}
