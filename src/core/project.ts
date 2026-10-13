/**
 * The Eval Project: a directory of evals kept apart from the Static Resources
 * it evaluates, so nothing in it can reach the agent.
 *
 *   <project>/eval-project.yml          defaults and `search_paths.<kind>`
 *   <project>/<kind>/<name>/eval.yml    one eval per resource, named after it
 *   <project>/<kind>/<name>/graders/    ... and its graders, judges, task workspaces
 *
 * A resource's kind is whichever search path it is found in, and its name is
 * its directory name.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { EVAL_FILE, LEGACY_EVAL_FILE } from './config';

export const PROJECT_FILE = 'eval-project.yml';

export type ResourceKind = 'skill' | 'prompt';

/**
 * The kinds a project can hold. The key is both the `search_paths` key and the
 * eval directory's name in the project. A resource is either a directory
 * holding `marker`, or a single `<name>.<ext>` file.
 */
const KINDS: Record<string, { kind: ResourceKind } & ({ marker: string } | { ext: string })> = {
    skills: { kind: 'skill', marker: 'SKILL.md' },
    prompts: { kind: 'prompt', ext: '.md' },
};

export interface Project {
    dir: string;
    defaults: Record<string, any>;
    /** Project-wide Prompt variables; a task's own values override them. */
    variables: Record<string, unknown>;
    /** Absolute search paths per kind key. */
    searchPaths: Record<string, string[]>;
}

/** A Static Resource that has an eval in the project. */
export interface Resource {
    kind: ResourceKind;
    name: string;
    /** The resource itself, in one of the search paths: a directory, or the file of a Prompt. */
    dir: string;
    /** Its directory in the Eval Project: eval.yml, graders/, workspace/. */
    evalDir: string;
}

export async function loadProject(dir: string): Promise<Project> {
    const file = path.join(dir, PROJECT_FILE);
    if (await fs.pathExists(path.join(dir, LEGACY_EVAL_FILE))) {
        throw new Error(`${dir}: eval.yaml is no longer supported. Create an Eval Project instead: ${PROJECT_FILE} here, with one <kind>/<name>/${EVAL_FILE} per resource (see docs).`);
    }
    if (!await fs.pathExists(file)) {
        throw new Error(`No ${PROJECT_FILE} found in ${dir}. Run skillgrade from an Eval Project directory.`);
    }

    const raw = yaml.load(await fs.readFile(file, 'utf-8')) as any;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${PROJECT_FILE} must be a YAML object`);
    }
    const declared = raw.search_paths;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared) || Object.keys(declared).length === 0) {
        throw new Error(`${PROJECT_FILE} must declare where resources are found, e.g. search_paths: { skills: ["../skills"] }`);
    }

    const searchPaths: Record<string, string[]> = {};
    for (const [key, paths] of Object.entries<any>(declared)) {
        if (!KINDS[key]) {
            throw new Error(`${PROJECT_FILE}: search_paths.${key} is not a resource kind. Supported: ${Object.keys(KINDS).join(', ')}`);
        }
        if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) {
            throw new Error(`${PROJECT_FILE}: search_paths.${key} must be a list of paths`);
        }
        searchPaths[key] = paths.map(p => path.resolve(dir, p));
        for (const p of searchPaths[key]) {
            if (!await fs.pathExists(p)) throw new Error(`${PROJECT_FILE}: search_paths.${key} path not found: ${p}`);
        }
    }

    if (raw.variables !== undefined && (typeof raw.variables !== 'object' || raw.variables === null || Array.isArray(raw.variables))) {
        throw new Error(`${PROJECT_FILE}: variables must be an object mapping each {{placeholder}} to its value`);
    }

    return { dir, defaults: raw.defaults ?? {}, variables: raw.variables ?? {}, searchPaths };
}

/** The Eval Project defaults for the eval in `evalDir` (<project>/<kind>/<name>); none when it is not in a loadable project. */
export async function projectDefaultsOf(evalDir: string): Promise<Record<string, any>> {
    try {
        return (await loadProject(path.dirname(path.dirname(evalDir)))).defaults;
    } catch {
        return {};
    }
}

/**
 * The resources that have an eval in the project, in a stable order. Every
 * resource in the search paths is checked, tested or not, so a bad name fails
 * before any trial runs.
 */
export async function testedResources(project: Project): Promise<Resource[]> {
    const found = await findResources(project);

    const tested: Resource[] = [];
    for (const [key, { kind }] of Object.entries(KINDS)) {
        const kindDir = path.join(project.dir, key);
        const entries = await fs.readdir(kindDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
            const evalDir = path.join(kindDir, entry.name);
            // eval.yaml counts: loading it explains that it is no longer supported
            const hasEval = await fs.pathExists(path.join(evalDir, EVAL_FILE)) || await fs.pathExists(path.join(evalDir, LEGACY_EVAL_FILE));
            if (!hasEval) continue;
            const resource = found.find(r => r.kind === kind && r.name === entry.name);
            if (!resource) {
                throw new Error(`${path.join(key, entry.name)} holds an eval, but there is no ${kind} named "${entry.name}" in search_paths.${key} (${(project.searchPaths[key] || []).join(', ') || 'none declared'})`);
            }
            tested.push({ ...resource, evalDir });
        }
    }
    return tested;
}

/** Every resource in the search paths, named by its directory; fails on a name that does not match its frontmatter. */
async function findResources(project: Project): Promise<Omit<Resource, 'evalDir'>[]> {
    const found: Omit<Resource, 'evalDir'>[] = [];
    for (const [key, spec] of Object.entries(KINDS)) {
        const { kind } = spec;
        for (const searchPath of project.searchPaths[key] || []) {
            const entries = (await fs.readdir(searchPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                // A directory holding the marker file, or a file with the extension: named by its directory or file name
                let name: string, dir: string, nameFile: string, named: 'directory' | 'file';
                if ('marker' in spec) {
                    if (!entry.isDirectory()) continue;
                    name = entry.name;
                    dir = path.join(searchPath, entry.name);
                    nameFile = path.join(dir, spec.marker);
                    named = 'directory';
                    if (!await fs.pathExists(nameFile)) continue;
                } else {
                    if (!entry.isFile() || !entry.name.endsWith(spec.ext)) continue;
                    name = entry.name.slice(0, -spec.ext.length);
                    dir = nameFile = path.join(searchPath, entry.name);
                    named = 'file';
                }

                checkName(nameFile, name, named, await fs.readFile(nameFile, 'utf-8'));
                const twin = found.find(r => r.kind === kind && r.name === name);
                if (twin) {
                    throw new Error(`Two ${kind}s are named "${name}": ${twin.dir} and ${dir}. Names are unique within a kind`);
                }
                found.push({ kind, name, dir });
            }
        }
    }
    return found;
}

/** The frontmatter `name:` is required and must be the resource's name (its directory's, or its file's without the extension). */
function checkName(file: string, resourceName: string, named: 'directory' | 'file', content: string) {
    const name = frontmatter(content).name;
    if (name === undefined || name === null || name === '') {
        throw new Error(`${file}: the frontmatter needs "name: ${resourceName}" (the ${named}'s name)`);
    }
    if (String(name) !== resourceName) {
        throw new Error(`${file}: frontmatter name "${name}" does not match its ${named} name "${resourceName}". Rename one so they agree`);
    }
}

/** A file's content without its frontmatter. */
export function promptBody(content: string): string {
    return content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
}

function frontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    try {
        const parsed = yaml.load(match[1]);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}
