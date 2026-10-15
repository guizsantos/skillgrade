/**
 * Shell helpers for building agent CLI invocations.
 */
import { randomUUID } from 'crypto';

/**
 * Single-quote a value for a POSIX shell.
 *
 * Agent commands are assembled as strings and handed to `sh -c`, so any value
 * that came from eval.yml or a CLI flag has to be quoted before it lands in
 * one.
 */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A fresh path for an agent's prompt file, unique per invocation so concurrent
 * runs (parallel trials, several skillgrade processes) never share one. It is
 * resolved by the runtime's shell (host or container), hence a literal /tmp.
 */
export function promptFilePath(): string {
    return `/tmp/.prompt-${randomUUID()}.md`;
}
