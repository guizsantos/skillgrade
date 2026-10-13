import { describe, it, expect } from 'vitest';
import { evalProject, fakeAgent, greeterProject, projectYml } from './helpers/evalProject';

describe('--harness and --runtime', () => {
    it('lay out the task for the harness and runtime that run, not the ones the project names', async () => {
        const fx = await evalProject(ctx => {
            const command = fakeAgent({ record: ctx.record });
            return {
                ...greeterProject(command),
                // the project asks for Docker and the Gemini CLI; the run overrides both
                'evals/eval-project.yml': projectYml(command, { defaults: { harness: 'gemini-cli', runtime: 'docker', trials: 1 } }),
                'evals/skills/greeter/workspace/say/data/input.txt': 'fixture\n',
            };
        });
        await fx.run({ harness: 'command', runtime: 'local', command: fakeAgent({ record: fx.record }) });

        const { files } = await fx.seen();
        expect(files['data/input.txt']).toBe('fixture\n');   // laid out for the local runtime
        expect(files).not.toHaveProperty('environment/Dockerfile');   // no image is built for it
        expect((await fx.reports('greeter'))[0].pass_rate).toBe(1);
    }, 60_000);
});
