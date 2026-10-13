import { BaseAgent, CommandResult } from '../types';
import { shellQuote } from '../utils/shell';

export interface OpenCodeAgentConfig {
    agent?: string;
    model?: string;
}

export class OpenCodeAgent extends BaseAgent {
    private config: OpenCodeAgentConfig;

    constructor(config: OpenCodeAgentConfig = {}) {
        super();
        this.config = config;
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const flags = [
            this.config.model ? `--model ${this.config.model}` : '',
            this.config.agent ? `--agent ${shellQuote(this.config.agent)}` : '',
        ].filter(Boolean).join(' ');
        const fullCommand = `cd '${_workspacePath.replace(/'/g, "'\\''")}' && echo '${instruction.replace(/'/g, "'\\''")}' | opencode run ${flags}`;

        const result = await runCommand(fullCommand);
        return result.stdout + '\n' + result.stderr;
    }
}
