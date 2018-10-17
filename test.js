'use strict';

const {createServer} = require('http');
const {createGzip} = require('zlib');

const brokenNpmPath = require('broken-npm-path');
const clearAllModules = require('clear-module').all;
const noop = require('lodash/fp/noop');
const {pack} = require('tar-stream');
const pathExists = require('path-exists');
const pRetry = require('p-retry');
const readUtf8File = require('read-utf8-file');
const rmfr = require('rmfr');
const test = require('tape');

const largeBuf = Buffer.from('.'.repeat(9999999));

test('dlTar() with broken PATH', t => {
	t.plan(1);

	const originalPath = process.env.PATH;
	const originalNpmExecPath = process.env.npm_execpath;
	process.env.PATH = '/n/p/m/_/d/o/e/s/_/n/o/t/_/e/x/i/s/t/_/h/e/r/e';
	process.env.npm_execpath = brokenNpmPath; // eslint-disable-line camelcase

	const dlTar = require('.');

	dlTar('http://localhost:3018', __dirname).subscribe({
		complete: t.fail.bind(t, 'Unexpectedly completed.'),
		error({code}) {
			t.ok(code, 'should fail to load `request` module.');

			process.env.PATH = originalPath;
			process.env.npm_execpath = originalNpmExecPath; // eslint-disable-line camelcase
		}
	});
});

const server = createServer((req, res) => {
	res.statusCode = 200;
	const tar = pack();

	if (req.url === '/') {
		tar.entry({name: 'dir', type: 'directory'});
		tar.entry({name: 'dir/1.txt'}, 'Hi');
		tar.entry({name: 'dir/nested/2.txt'}, 'Hello');
		tar.entry({name: 'dir/empty.txt'}, '');
		tar.finalize();
		res.setHeader('content-type', 'application/x-tar');
    res.setHeader('content-length', `${tar._readableState.length}`); // eslint-disable-line
		tar.pipe(res);

		return;
	}

	if (req.url === '/enotempty') {
		tar.entry({name: 'dir', type: 'directory'});
		tar.entry({name: 'dir/node_modules'}, 'Hi');
		tar.finalize();
		res.setHeader('content-type', 'application/x-tar');
    res.setHeader('content-length', `${tar._readableState.length}`); // eslint-disable-line
		tar.pipe(res);

		return;
	}

	if (req.url === '/non-tar') {
		res.setHeader('content-Type', 'text/plain');
		res.end('plain text'.repeat(100));
		return;
	}

	res.setHeader('content-encoding', 'gzip');
	tar.entry({name: 'dir/huge.txt'}, largeBuf);
	tar.entry({name: 'dir/rest.txt'}, 'Hey');
	tar.finalize();
	tar.pipe(createGzip()).pipe(res);
}).listen(3018, () => {
	test('dlTar()', async t => {
		t.plan(21);

		clearAllModules();
		const dlTar = require('.');

		await rmfr('tmp');

		dlTar('http://localhost:3018/', 'tmp/a').subscribe({
			next(progress) {
				if (progress.entry.path === '') {
					t.equal(
						progress.entry.header.type,
						'Directory',
						'should send progress when a directory is created.'
					);
					t.equal(
						progress.entry.size,
						0,
						'should consider the size of directory as 0.'
					);

					return;
				}

				if (progress.entry.path === '1.txt') {
					if (progress.entry.remain === 2) {
						t.pass('should notify the beginning of extraction to the observer.');
					} else if (progress.entry.remain === 0) {
						t.pass('should notify the ending of extraction to the observer.');
					}

					return;
				}

				if (progress.entry.path === 'empty.txt') {
					t.equal(
						progress.entry.remain,
						0,
						'should send extraction progress even if the file is 0 byte.'
					);

					return;
				}

				if (progress.entry.remain === 0) {
					t.equal(
						progress.entry.header.path,
						'dir/nested/2.txt',
						'should send entry headers to the observer.'
					);

					t.equal(
						progress.response.url,
						'http://localhost:3018/',
						'should send the request URL to the observer.'
					);

					t.ok(
						Number.isSafeInteger(progress.response.bytes),
						'should send total donwload bytes to the observer.'
					);

					t.equal(
						progress.response.headers['content-type'],
						'application/x-tar',
						'should send response headers to the observer.'
					);

					t.equal(
						progress.response.headers['content-length'],
						4096,
						'should convert `content-length` header from string to number.'
					);
				}
			},
			error: t.fail,
			async complete() {
				const contents = await Promise.all([
					readUtf8File('tmp/a/1.txt'),
					readUtf8File('tmp/a/nested/2.txt')
				]);

				t.deepEqual(contents, ['Hi', 'Hello'], 'should download a tar and extract it to the disk.');
			}
		});

		dlTar('http://localhost:3018/', 'tmp/b', {
			strip: 0,
			filter(file) {
				return file !== 'dir/1.txt';
			}
		}).subscribe({
			error: t.fail,
			async complete() {
				const [fileExists, ignoredFileExists] = await Promise.all([
					pathExists('tmp/b/dir/nested/2.txt'),
					pathExists('tmp/b/dir/1.txt')
				]);

				t.ok(fileExists, 'should extract files passed `filter` function.');
				t.notOk(ignoredFileExists, 'should leave ignored files unextracted.');
			}
		});

		const fail = t.fail.bind(t, 'Unexpectedly succeeded.');

		const subscription = dlTar('/huge', 'tmp/c', {baseUrl: 'http://localhost:3018'}).subscribe({
			async next() {
				subscription.unsubscribe();

				const content = await pRetry(() => readUtf8File('tmp/c/huge.txt'));
				t.equal(content.slice(0, 3), '...', 'should gunzip response if needed.');
				t.ok(
					content.length < largeBuf.length,
					'should stop extraction when the subscription is unsubscribed.'
				);

				t.notOk(
					await pathExists('tmp/c/rest.txt'),
					'should ignore unextracted entries after unsubscription.'
				);
			},
			error: t.fail,
			complete: fail
		});

		const subscriptionImmediatelyUnsubscribed = dlTar('https://example.org', '.').subscribe({
			error: t.fail,
			complete: fail
		});

		subscriptionImmediatelyUnsubscribed.unsubscribe();

		t.equal(
			subscriptionImmediatelyUnsubscribed.closed,
			true,
			'should be immediately unsubscribable.'
		);

		dlTar('http://localhost:3018', __filename).subscribe({
			complete: fail,
			error: ({code}) => t.equal(code, 'EEXIST', 'should fail when it cannot create directories.')
		});

		dlTar('http://localhost:3018/enotempty', __dirname).subscribe({
			error({code}) {
				t.equal(code, 'ENOTEMPTY', 'should fail when it cannot write files.');
			},
			complete: fail
		});

		dlTar('http://localhost:3018/non-tar', __dirname).subscribe({
			complete: fail,
			error: err => t.equal(
				err.toString(),
				'Error: invalid entry',
				'should fail when the downloaded content is not a tar archive.'
			)
		});

		dlTar('https://example.org/4/0/4/n/o/t/f/o/u/n/d', __dirname, {method: 'GET'}).subscribe({
			complete: fail,
			error: err => t.equal(
				err.toString(),
				'Error: 404 Not Found',
				'should fail when the requested content is not found.'
			)
		});
	});

	test('Argument validation', async t => {
		const dlTar = require('.');

		async function getError(...args) {
			try {
				return await dlTar(...args).forEach(noop);
			} catch (err) {
				return err.toString();
			}
		}

		t.equal(
			await getError(),
			'RangeError: Expected 2 or 3 arguments (<string>, <string>[, <Object>]), but got no arguments instead.',
			'should fail when no argument is passed.'
		);

		t.equal(
			await getError('', '', {}, {}),
			'RangeError: Expected 2 or 3 arguments (<string>, <string>[, <Object>]), but got 4 arguments instead.',
			'should fail when too many argument are passed.'
		);

		t.equal(
			await getError(Math.sign, '__'),
			'TypeError: Expected a URL of tar archive, but got [Function: sign].',
			'should fail when the URL is not a string.'
		);

		t.equal(
			await getError('', '__'),
			'Error: Expected a URL of tar archive, but got \'\' (empty string).',
			'should fail when the URL is an empty string.'
		);

		t.equal(
			await getError('http://localhost:3018/', [0]),
			'TypeError: Expected a path where downloaded tar archive will be extracted, but got [ 0 ].',
			'should fail when the destination path is not a string.'
		);

		t.equal(
			await getError('http://localhost:3018/', ''),
			'Error: Expected a path where downloaded tar archive will be extracted, but got \'\' (empty string).',
			'should fail when the destination path is an empty string.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', false),
			'TypeError: Expected an object to specify `dl-tar` options, but got false.',
			'should fail when it takes a non-object option.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {method: Buffer.from('0')}),
			'TypeError: Invalid `method` option: <Buffer 30>. `dl-tar` module is designed to download archive files. ' +
      'So it only supports the default request method "GET" and it cannot be overridden by `method` option.',
			'should fail when the `method` option is not a string.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {method: 'POST'}),
			'Error: Invalid `method` option: \'POST\'. `dl-tar` module is designed to download archive files. ' +
      'So it only supports the default request method "GET" and it cannot be overridden by `method` option.',
			'should fail when the `method` option is a string but not `GET`.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {filter: new Set()}),
			'TypeError: `filter` option must be a function, but got Set {}.',
			'should fail when `filter` option is not a function.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {onwarn: new Uint16Array()}),
			'TypeError: `onwarn` option must be a function, but got Uint16Array [].',
			'should fail when `onwarn` option is not a function.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {transform: new Uint32Array()}),
			'TypeError: `transform` option must be a function, but got Uint32Array [].',
			'should fail when `transform` option is not a function.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {strip: '!'}),
			'TypeError: Expected `strip` option to be a non-negative integer (0, 1, ...) that specifies ' +
      'how many leading components from file names will be stripped, but got a non-number value \'!\'.',
			'should fail when `strip` option is not a number.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {strip: -Infinity}),
			'RangeError: Expected `strip` option to be a non-negative integer (0, 1, ...) that specifies ' +
      'how many leading components from file names will be stripped, but got -Infinity.',
			'should fail when `strip` option is infinite.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {strip: NaN}),
			'RangeError: Expected `strip` option to be a non-negative integer (0, 1, ...) that specifies ' +
      'how many leading components from file names will be stripped, but got NaN.',
			'should fail when `strip` option is NaN.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {strip: Number.MAX_SAFE_INTEGER + 1}),
			'RangeError: Expected `strip` option to be a non-negative integer (0, 1, ...) that specifies ' +
      'how many leading components from file names will be stripped, but got a too large number.',
			'should fail when `strip` option exceeds the max safe integer.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {strip: -1}),
			'RangeError: Expected `strip` option to be a non-negative integer (0, 1, ...) that specifies ' +
      'how many leading components from file names will be stripped, but got a negative number -1.',
			'should fail when `strip` option is a negative number.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {strip: 1.999}),
			'Error: Expected `strip` option to be a non-negative integer (0, 1, ...) that specifies ' +
      'how many leading components from file names will be stripped, but got a non-integer number 1.999.',
			'should fail when `strip` option is a non-integer number.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {onentry: noop}),
			'Error: `dl-tar` does not support `onentry` option.',
			'should fail when `onentry` option is provided.'
		);

		t.end();
	});
});

test.onFinish(() => server.close());
