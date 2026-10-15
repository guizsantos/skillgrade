// Deterministic grader: the summary names the version (and the product, when the task
// expects one). The answer key arrives as JSON in SKILLGRADE_INPUT, never in the workspace.
const fs = require('fs');

const { expected } = JSON.parse(process.env.SKILLGRADE_INPUT);
const summary = fs.existsSync('SUMMARY.txt') ? fs.readFileSync('SUMMARY.txt', 'utf8') : '';

const checks = [
  { name: 'summary-written', passed: summary.trim().length > 0, message: 'SUMMARY.txt has content' },
  { name: 'names-version', passed: summary.includes(expected.version), message: `mentions ${expected.version}` },
];
if (expected.product) {
  checks.push({ name: 'names-product', passed: summary.includes(expected.product), message: `mentions ${expected.product}` });
}

const passed = checks.filter(c => c.passed).length;
console.log(JSON.stringify({ score: passed / checks.length, details: `${passed}/${checks.length} checks passed`, checks }));
