import { describe, expect, it, vi } from 'vitest'
import {
    buildOpenWorkspaceCommands,
    openWorkspaceInEditor,
    type OpenWorkspaceLaunchCommand,
} from './openWorkspace'

describe('buildOpenWorkspaceCommands', () => {
    it('prefers LaunchServices and falls back to the code CLI on macOS', () => {
        expect(buildOpenWorkspaceCommands('/repo/hapi', 'darwin')).toEqual([
            { command: 'open', args: ['-a', 'Visual Studio Code', '/repo/hapi'] },
            { command: 'code', args: ['/repo/hapi'] },
        ])
    })

    it('uses the code CLI on Linux and the Code.exe install layout on Windows', () => {
        expect(buildOpenWorkspaceCommands('/repo/hapi', 'linux')).toEqual([
            { command: 'code', args: ['/repo/hapi'] },
        ])
        expect(buildOpenWorkspaceCommands('C:\\repo\\hapi', 'win32', {
            LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
            ProgramFiles: 'C:\\Program Files',
        })).toEqual([
            {
                command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
                args: ['C:\\repo\\hapi'],
            },
            {
                command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
                args: ['C:\\repo\\hapi'],
            },
            { command: 'Code.exe', args: ['C:\\repo\\hapi'] },
        ])
    })
})

describe('openWorkspaceInEditor', () => {
    it('returns success on the first working launch command', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined)
        const result = await openWorkspaceInEditor('/repo/hapi', {
            platform: 'darwin',
            runCommand,
        })

        expect(result).toEqual({ success: true })
        expect(runCommand).toHaveBeenCalledWith({
            command: 'open',
            args: ['-a', 'Visual Studio Code', '/repo/hapi'],
        })
    })

    it('falls back to the code CLI when open cannot find the app', async () => {
        const runCommand = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('Command failed'), {
                stderr: "Unable to find application named 'Visual Studio Code'",
            }))
            .mockResolvedValueOnce(undefined)

        const result = await openWorkspaceInEditor('/repo/hapi', {
            platform: 'darwin',
            runCommand,
        })

        expect(result).toEqual({ success: true })
        expect(runCommand).toHaveBeenCalledTimes(2)
        expect(runCommand).toHaveBeenLastCalledWith({
            command: 'code',
            args: ['/repo/hapi'],
        })
    })

    it('reports every launch failure when no command works', async () => {
        const commands: OpenWorkspaceLaunchCommand[] = []
        const runCommand = vi.fn().mockImplementation(async (command: OpenWorkspaceLaunchCommand) => {
            commands.push(command)
            throw Object.assign(new Error(`failed: ${command.command}`), {
                stderr: `cannot run ${command.command}`,
            })
        })

        const result = await openWorkspaceInEditor('/repo/hapi', {
            platform: 'darwin',
            runCommand,
        })

        expect(result).toEqual({
            success: false,
            error: 'cannot run open; cannot run code',
        })
        expect(commands).toHaveLength(2)
    })
})
