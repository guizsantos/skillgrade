import { describe, it, expect } from 'vitest';
import { parseTaskRef, resolveTaskRef, ResourceTasks } from '../src/core/taskRef';

describe('parseTaskRef', () => {
    it('reads the bare form: a task of the same eval', () => {
        expect(parseTaskRef('setup')).toEqual({ task: 'setup' });
    });

    it('reads name@resource: a task of a resource, found by its unique name', () => {
        expect(parseTaskRef('setup@other-skill')).toEqual({ task: 'setup', resource: 'other-skill' });
    });

    it('reads name@kind:resource: the full form', () => {
        expect(parseTaskRef('setup@skills:other-skill')).toEqual({ task: 'setup', kind: 'skills', resource: 'other-skill' });
    });

    it.each([
        ['', /empty/],
        ['  ', /empty/],
        ['@res', /task name/],
        ['name@', /resource/],
        ['name@:res', /kind/],
        ['name@skills:', /resource/],
        ['a@b@c', /one "@"/],
        ['a@k:b:c', /one ":"/],
    ])('rejects %j', (ref, message) => {
        expect(() => parseTaskRef(ref)).toThrow(message);
    });
});

describe('resolveTaskRef', () => {
    const res = (kind: string, name: string, tasks: string[]): ResourceTasks => ({ kind, name, tasks, evalDir: `/p/${kind}/${name}` });
    const greeter = res('skills', 'greeter', ['say', 'wave']);
    const all = [greeter, res('skills', 'farewell', ['wave', 'bye']), res('prompts', 'shared', ['bye']), res('skills', 'shared', ['bye'])];

    it('resolves a bare name within the same eval', () => {
        expect(resolveTaskRef('wave', greeter, all)).toEqual({ task: 'wave', evalDir: '/p/skills/greeter' });
    });

    it('a bare name never looks at other resources, and says where it exists', () => {
        expect(() => resolveTaskRef('bye', greeter, all)).toThrow(/"bye" not defined in "greeter".*did you mean one of bye@skills:farewell, bye@prompts:shared, bye@skills:shared\?/s);
    });

    it('an unknown bare name with no match anywhere has no hint', () => {
        expect(() => resolveTaskRef('nope', greeter, all)).toThrow(/^"nope" not defined in "greeter"$/);
    });

    it('resolves name@resource when the resource name is unique', () => {
        expect(resolveTaskRef('bye@farewell', greeter, all)).toEqual({ task: 'bye', evalDir: '/p/skills/farewell' });
    });

    it('name@resource for a task the resource lacks says so', () => {
        expect(() => resolveTaskRef('say@farewell', greeter, all)).toThrow(/"say" not defined in "farewell"/);
    });

    it('name@resource for an unknown resource says so', () => {
        expect(() => resolveTaskRef('say@ghost', greeter, all)).toThrow(/no resource "ghost"/);
    });

    it('an ambiguous resource name asks for name@kind:resource', () => {
        expect(() => resolveTaskRef('bye@shared', greeter, all)).toThrow(/"shared".*prompts, skills.*bye@<kind>:shared/s);
    });

    it('the full form resolves an ambiguous resource name', () => {
        expect(resolveTaskRef('bye@prompts:shared', greeter, all)).toEqual({ task: 'bye', evalDir: '/p/prompts/shared' });
        expect(resolveTaskRef('bye@skills:shared', greeter, all)).toEqual({ task: 'bye', evalDir: '/p/skills/shared' });
    });

    it('the full form with a kind that has no such resource says so', () => {
        expect(() => resolveTaskRef('bye@prompts:farewell', greeter, all)).toThrow(/no resource "farewell" in prompts/);
    });
});
