/**
 * `skillgrade preview` command.
 *
 * Opens the CLI results viewer (this Eval Project's results, resource by
 * resource), or the browser site (every resource's results under the output directory).
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { PROJECT_FILE, loadProject, testedResources } from '../core/project';
import { runCliPreview } from '../reporters/cli';
import { runBrowserPreview } from '../reporters/browser';

export async function runPreview(dir: string, mode: 'cli' | 'browser', outputDir?: string, port?: number) {
    const base = outputDir || path.join(os.tmpdir(), 'skillgrade');

    if (mode === 'browser') {
        await runBrowserPreview(base, port);
    } else if (await fs.pathExists(path.join(dir, PROJECT_FILE))) {
        for (const resource of await testedResources(await loadProject(dir))) {
            const results = path.join(base, resource.name, 'results');
            if (await fs.pathExists(results)) await runCliPreview(results);
        }
    } else {
        await runCliPreview(path.join(base, path.basename(dir), 'results'));
    }
}
