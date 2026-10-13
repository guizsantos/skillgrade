import { describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { runEvals } from '../src/commands/run';

describe('--harness and --runtime', () => {
    it('lay out the task for the harness and runtime that run, not the ones eval.yaml names', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-overrides-'));
        const output = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-overrides-out-'));
        await fs.outputFile(path.join(dir, 'SKILL.md'), '---\nname: s\ndescription: d\n---\nbody\n');
        await fs.outputFile(path.join(dir, 'fixtures', 'input.txt'), 'fixture\n');
        await fs.outputFile(path.join(dir, 'eval.yaml'), `defaults:
  harness: gemini-cli
  runtime: docker
  trials: 1
tasks:
  - name: t
    instruction: go
    workspace:
      - src: fixtures/input.txt
        dest: data/input.txt
    graders:
      - type: deterministic
        run: "test -f data/input.txt && echo '{\\"score\\":1,\\"details\\":\\"at dest\\"}' || echo '{\\"score\\":0,\\"details\\":\\"not at dest\\"}'"
`);
        // the command harness reports whether the image would install the Gemini CLI
        await runEvals(dir, {
            harness: 'command', runtime: 'local', output,
            command: 'echo "gemini-cli installs: $(grep -c gemini-cli environment/Dockerfile)"',
        });

        const [file] = await fs.readdir(path.join(output, path.basename(dir), 'results'));
        const report = await fs.readJson(path.join(output, path.basename(dir), 'results', file));
        expect(report.trials[0].grader_results[0].details).toBe('at dest');   // laid out for the local runtime
        expect(JSON.stringify(report.trials[0].session_log)).toContain('gemini-cli installs: 0');  // the Dockerfile follows --harness
    }, 60_000);
});
