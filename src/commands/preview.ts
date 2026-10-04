/**
 * `skillgrade preview` command.
 *
 * Opens the CLI results viewer (this skill's results), or the browser site
 * (every skill's results under the output directory).
 */
import * as path from 'path';
import * as os from 'os';
import { runCliPreview } from '../reporters/cli';
import { runBrowserPreview } from '../reporters/browser';

export async function runPreview(dir: string, mode: 'cli' | 'browser', outputDir?: string, port?: number) {
    const base = outputDir || path.join(os.tmpdir(), 'skillgrade');

    if (mode === 'browser') {
        await runBrowserPreview(base, port);
    } else {
        await runCliPreview(path.join(base, path.basename(dir), 'results'));
    }
}
