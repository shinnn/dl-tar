'use strict';

const {createServer} = require('http');
const {createGunzip, createGzip} = require('zlib');
const {normalize} = require('path');
const {Transform} = require('stream');

const clearAllModules = require('clear-module').all;
const {pack} = require('tar-stream');
const noop = require('nop');
const pathExists = require('path-exists');
const readUtf8File = require('read-utf8-file');
const rmfr = require('rmfr');
const test = require('tape');

const largeBuf = Buffer.from('.'.repeat(9999999));

test('dlTar() with broken PATH', t => {
	t.plan(1);

	const originalPath = process.env.PATH;
	process.env.PATH = '/n/p/m/_/d/o/e/s/_/n/o/t/_/e/x/i/s/t/_/h/e/r/e';

	const dlTar = require('.');

	dlTar('http://localhost:3018', '__').subscribe({
		error({code}) {
			t.ok(code, 'should fail to load `request` module.');

			process.env.PATH = originalPath;
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

	if (req.url === '/eisdir') {
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
				if (progress.entry.header.name === '') {
					t.equal(
						progress.entry.header.type,
						'directory',
						'should send progress when a directory is created.'
					);
					t.equal(
						progress.entry.bytes,
						0,
						'should consider the size of directory as 0.'
					);

					return;
				}

				if (progress.entry.header.name === '1.txt') {
					if (progress.entry.bytes === 0) {
						t.pass('should notify the beginning of extraction to the observer.');
					} else if (progress.entry.bytes === 2) {
						t.pass('should notify the ending of extraction to the observer.');
					}

					return;
				}

				if (progress.entry.header.name === 'empty.txt') {
					t.equal(
						progress.entry.bytes,
						0,
						'should send extraction progress even if the file is 0 byte.'
					);

					return;
				}

				if (progress.entry.bytes === 0) {
					t.equal(
						progress.entry.header.name,
						'nested/2.txt',
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
			map(header) {
				header.name = `prefix-${header.name}`;
				return header;
			},
			mapStream(stream, header) {
				return stream.pipe(new Transform({
					transform(data, enc, cb) {
						cb(null, `${data.length / header.size * 100} %`);
					}
				}));
			},
			ignore(file) {
				return file === normalize('tmp/b/dir/1.txt');
			}
		}).subscribe({
			error: t.fail,
			async complete() {
				const [content, ignoredFileExists] = await Promise.all([
					readUtf8File('tmp/b/prefix-dir/nested/2.txt'),
					pathExists('tmp/b/prefix-dir/1.txt')
				]);

				t.equal(content, '100 %', 'should support tar-fs options.');
				t.notOk(ignoredFileExists, 'should leave ignored files unextracted.');
			}
		});

		const fail = t.fail.bind(t, 'Unexpectedly succeeded.');

		const subscription = dlTar('/huge', 'tmp/c', {
			baseUrl: 'http://localhost:3018',
			tarTransform: createGunzip()
		}).subscribe({
			async next() {
				subscription.unsubscribe();

				const content = await readUtf8File('tmp/c/huge.txt');
				t.equal(content.slice(0, 3), '...', 'should support `tarTransform` option.');
				t.notEqual(
					content.length,
					largeBuf.length,
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

		dlTar('http://localhost:3018', __filename).subscribe({
			start(subscriptionItself) {
				process.nextTick(() => {
					t.ok(subscriptionItself.closed, 'should be immediately unsubscribable.');
				});
			},
			error: t.fail,
			complete: fail
		}).unsubscribe();

		dlTar('http://localhost:3018', __filename).subscribe({
			complete: fail,
			error: ({code}) => t.equal(code, 'EEXIST', 'should fail when it cannot create directories.')
		});

		dlTar('http://localhost:3018/eisdir', __dirname).subscribe({
			error({code}) {
				t.equal(code, 'EISDIR', 'should fail when it cannot write files.');
			},
			complete: fail
		});

		dlTar('http://localhost:3018/non-tar', '__').subscribe({
			complete: fail,
			error: err => t.equal(
				err.toString(),
				'Error: Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?',
				'should fail when the downloaded content is not a tar archive.'
			)
		});

		dlTar('https://example.org/4/0/4/n/o/t/f/o/u/n/d', '__', {method: 'GET'}).subscribe({
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
			await getError('http://localhost:3018/', '__', {tarTransform: 0}),
			'TypeError: `tarTransform` option must be a transform stream that modifies ' +
      'the downloaded tar archive before extracting, but got a non-stream value 0.',
			'should fail when `tarTransform` option is not an object.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {tarTransform: process.stdin}),
			'TypeError: `tarTransform` option must be a transform stream that modifies ' +
      'the downloaded tar archive before extracting, but got a readable stream instead.',
			'should fail when `tarTransform` option is a non-transform stream.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {ignore: /^/}),
			'TypeError: `ignore` option must be a function, but got /^/ (regexp).',
			'should fail when `ignore` option is not a function.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {map: new WeakSet()}),
			'TypeError: `map` option must be a function, but got WeakSet {}.',
			'should fail when `map` option is not a function.'
		);

		t.equal(
			await getError('http://localhost:3018/', '__', {mapStream: new Uint8Array()}),
			'TypeError: `mapStream` option must be a function, but got Uint8Array [  ].',
			'should fail when `mapTransform` option is not a function.'
		);

		t.equal(
			await getError('http://localhost:3018', 'tmp/d', {mapStream: () => new Uint16Array()}),
			'TypeError: The function passed to `mapStream` option must return a stream,' +
      ' but returned a non-stream value Uint16Array [  ].',
			'should fail when `mapTransform` option returns a non-stream value.'
		);

		t.equal(
			await getError('http://localhost:3018', 'tmp/e', {mapStream: () => process.stdout}),
			'TypeError: The function passed to `mapStream` option must return a stream' +
      ' that is readable, but returned a non-readable stream.',
			'should fail when `mapTransform` option returns a non-readable stream.'
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

		t.end();
	});
});

test.onFinish(() => server.close());
