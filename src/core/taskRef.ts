/**
 * Task references: how a task names another task whose workspace it reuses
 * (`workspace: [{task: <ref>}]`).
 *
 *   name                  a task of the same eval
 *   name@resource         a task of a resource anywhere in the project, when the resource name is unique
 *   name@kind:resource    the same, when the name exists in more than one kind (`kind` is the
 *                         project directory's name: skills, ...)
 */

export interface TaskRef {
    task: string;
    resource?: string;
    kind?: string;
}

export function parseTaskRef(ref: string): TaskRef {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('Task reference is empty; expected name, name@resource or name@kind:resource');
    const parts = ref.trim().split('@');
    if (parts.length > 2) throw new Error(`Task reference "${ref}" has more than one "@"; expected name, name@resource or name@kind:resource`);
    const [task, target] = parts;
    if (!task) throw new Error(`Task reference "${ref}" has no task name before the "@"`);
    if (target === undefined) return { task };
    if (!target) throw new Error(`Task reference "${ref}" has no resource after the "@"`);

    const qualified = target.split(':');
    if (qualified.length > 2) throw new Error(`Task reference "${ref}" has more than one ":"; expected name@kind:resource`);
    if (qualified.length === 1) return { task, resource: target };
    const [kind, resource] = qualified;
    if (!kind) throw new Error(`Task reference "${ref}" has no kind before the ":"`);
    if (!resource) throw new Error(`Task reference "${ref}" has no resource after the ":"`);
    return { task, kind, resource };
}

/** A resource that has an eval, and the names of its tasks. `kind` is its project directory's name. */
export interface ResourceTasks {
    kind: string;
    name: string;
    tasks: string[];
    evalDir: string;
}

export interface ResolvedTaskRef {
    task: string;
    /** The eval directory the task lives in. */
    evalDir: string;
}

/** Find the task `ref` names, as written in an eval of resource `from`. Throws with what to write instead. */
export function resolveTaskRef(ref: string, from: ResourceTasks, all: ResourceTasks[]): ResolvedTaskRef {
    const parsed = parseTaskRef(ref);

    let target = from;
    if (parsed.resource !== undefined) {
        const named = all.filter(r => r.name === parsed.resource && (parsed.kind === undefined || r.kind === parsed.kind));
        if (named.length === 0) {
            throw new Error(parsed.kind !== undefined
                ? `Task reference "${ref}": no resource "${parsed.resource}" in ${parsed.kind} has an eval`
                : `Task reference "${ref}": no resource "${parsed.resource}" has an eval in this project`);
        }
        if (named.length > 1) {
            const kinds = named.map(r => r.kind).sort().join(', ');
            throw new Error(`Task reference "${ref}": "${parsed.resource}" exists in more than one kind (${kinds}); write ${parsed.task}@<kind>:${parsed.resource}`);
        }
        target = named[0];
    }

    if (!target.tasks.includes(parsed.task)) {
        const elsewhere = parsed.resource === undefined
            ? all.filter(r => r !== from && r.tasks.includes(parsed.task)).map(r => `${parsed.task}@${r.kind}:${r.name}`)
            : [];
        throw new Error(`"${parsed.task}" not defined in "${target.name}"` + (elsewhere.length ? `; did you mean one of ${elsewhere.join(', ')}?` : ''));
    }
    return { task: parsed.task, evalDir: target.evalDir };
}
