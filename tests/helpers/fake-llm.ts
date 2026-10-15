/**
 * A scripted OpenAI-compatible server on localhost, so an `llm_rubric` grader
 * can be exercised end to end with no LLM and no network.
 *
 *   const llm = await fakeLlm(prompt => ({ score: prompt.includes('GOOD') ? 1 : 0, reasoning: 'ok' }));
 *   llm.use();                       // points the OpenAI provider at it
 *   ...
 *   expect(llm.prompts).toHaveLength(1);
 *   await llm.close();               // also restores the environment
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface FakeLlm {
    url: string;
    /** Every judge prompt received, in order. */
    prompts: string[];
    /** The model each prompt was sent with, in the same order. */
    models: string[];
    /** Point the `openai` llm_provider at this server for the rest of the test. */
    use(): void;
    close(): Promise<void>;
}

export async function fakeLlm(reply: (prompt: string) => { score: number; reasoning?: string } = () => ({ score: 1, reasoning: 'fine' })): Promise<FakeLlm> {
    const prompts: string[] = [];
    const models: string[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const parsed = JSON.parse(body);
            const prompt: string = parsed.messages[0].content;
            prompts.push(prompt);
            models.push(parsed.model);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(prompt)) } }] }));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    const saved = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
    const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    };
    return {
        url, prompts, models,
        use() {
            process.env.OPENAI_API_KEY = 'test-key';
            process.env.OPENAI_BASE_URL = url;
        },
        async close() {
            restore('OPENAI_API_KEY', saved.key);
            restore('OPENAI_BASE_URL', saved.base);
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}
