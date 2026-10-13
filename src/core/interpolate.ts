/**
 * The one interpolation point: every `{{variable}}` rendered anywhere goes
 * through `interpolate`. Today only Prompts are rendered; extending templating
 * to other YAML (Jinja-style) means changing this function, not its callers.
 * Loops, conditionals and macros are not supported.
 */

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Replace each `{{name}}` in `template` with its value from `variables`.
 * A value is used as written, never expanded again. A placeholder with no value
 * (absent or null) throws, naming every one that is missing.
 */
export function interpolate(template: string, variables: Record<string, unknown>): string {
    const missing = new Set<string>();
    const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
        const value = Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
        if (value === undefined || value === null) {
            missing.add(name);
            return '';
        }
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
    if (missing.size) {
        throw new MissingVariablesError([...missing]);
    }
    return rendered;
}

export class MissingVariablesError extends Error {
    constructor(public readonly names: string[]) {
        super(`no value for ${names.map(n => `{{${n}}}`).join(', ')}`);
    }
}
