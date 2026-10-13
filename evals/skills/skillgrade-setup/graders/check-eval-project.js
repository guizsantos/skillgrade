/**
 * Deterministic grader for the create-eval-project task.
 * Validates that the agent produced an Eval Project for the code-formatter skill.
 */
const fs = require('fs');

const PROJECT = 'evals/eval-project.yml';
const EVAL = 'evals/skills/code-formatter/eval.yml';

function read(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function run() {
    const checks = [];
    const check = (name, passed, ok, bad) => checks.push({ name, passed, message: passed ? ok : bad });

    const project = read(PROJECT);
    const evalYml = read(EVAL);

    check('project-file', project !== null, `${PROJECT} exists`, `${PROJECT} not found`);
    check('search-path', /search_paths:\s*\n\s+skills:/.test(project || ''), 'search_paths.skills present', 'Missing search_paths.skills');
    check('eval-file', evalYml !== null, `${EVAL} exists`, `${EVAL} not found`);
    check('has-tasks', /^tasks:/m.test(evalYml || ''), 'tasks section present', 'Missing tasks section');
    check('has-deterministic', /type:\s*deterministic/.test(evalYml || ''), 'Has deterministic grader', 'Missing deterministic grader');
    check('has-llm-rubric', /type:\s*llm_rubric|llm_judge:/.test(evalYml || ''), 'Has an LLM grader', 'Missing llm_rubric grader');
    // The single-file shape was removed: neither an eval.yaml nor a `skill:` key belongs here
    check('no-legacy-shape', !fs.existsSync('eval.yaml') && !fs.existsSync('evals/eval.yaml') && !/^skill:/m.test(evalYml || ''),
        'No legacy eval.yaml shape', 'Uses the removed eval.yaml shape (an eval.yaml file or a skill: key)');

    const passed = checks.filter(c => c.passed).length;
    console.log(JSON.stringify({ score: passed / checks.length, details: `${passed}/${checks.length} checks passed`, checks }));
}

run();
