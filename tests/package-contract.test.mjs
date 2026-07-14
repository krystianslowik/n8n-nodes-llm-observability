import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const publishWorkflow = await readFile(
	new URL('../.github/workflows/publish.yml', import.meta.url),
	'utf8',
);

test('release metadata is deterministic and documents the current version', () => {
	assert.match(packageJson.devDependencies['@n8n/node-cli'], /^\d+\.\d+\.\d+$/);
	assert.equal(packageJson.peerDependencies['n8n-workflow'], '*');
	assert.match(changelog, new RegExp(`^## ${packageJson.version} `, 'm'));
});

test('published package contains only the implemented Trace Exporter', () => {
	assert.deepEqual(packageJson.dependencies ?? {}, {});
	assert.deepEqual(packageJson.n8n.nodes, ['dist/nodes/TraceExporter/TraceExporter.node.js']);
	assert.equal(
		packageJson.files.some((path) => path.includes('Observability')),
		false,
	);
});

test('tag publishing runs tests and package verification before release', () => {
	const testsAt = publishWorkflow.indexOf('run: npm test');
	const packAt = publishWorkflow.indexOf('run: npm pack --dry-run --ignore-scripts');
	const releaseAt = publishWorkflow.lastIndexOf('npm run release');
	assert.ok(testsAt >= 0 && packAt >= 0 && releaseAt >= 0);
	assert.ok(testsAt < releaseAt, 'tests must run before npm release');
	assert.ok(packAt < releaseAt, 'package verification must run before npm release');
});
