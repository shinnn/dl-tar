/*!
 * dl-tar | MIT (c) Shinnosuke Watanabe
 * https://github.com/shinnn/dl-tar
*/
'use strict';

const inspect = require('util').inspect;
const stream = require('stream');

const Transform = stream.Transform;
const PassThrough = stream.PassThrough;

const extract = require('tar-fs').extract;
const gracefulFs = require('graceful-fs');
const isPlainObj = require('is-plain-obj');
const isStream = require('is-stream');
const loadRequestFromCwdOrNpm = require('load-request-from-cwd-or-npm');
const Observable = require('zen-observable');
const pump = require('pump');

const priorOption = {encoding: null};

function echo(val) {
  return val;
}

const DEST_ERROR = 'Expected a path where downloaded tar archive will be extracted';
const TAR_TRANSFORM_ERROR = '`tarTransform` option must be a transform stream ' +
                            'that modifies the downloaded tar archive before extracting';
const MAP_STREAM_ERROR = 'The function passed to `mapStream` option must return a stream';
const STRIP_ERROR = 'Expected `strip` option to be a non-negative integer (0, 1, ...) ' +
                    'that specifies how many leading components from file names will be stripped';

module.exports = function dlTar(url, dest, options) {
  return new Observable(observer => {
    if (typeof url !== 'string') {
      throw new TypeError(`Expected a URL of tar archive, but got ${inspect(url)}.`);
    }

    if (url.length === 0) {
      throw new Error('Expected a URL of tar archive, but got \'\' (empty string).');
    }

    if (typeof dest !== 'string') {
      throw new TypeError(`${DEST_ERROR}, but got ${inspect(dest)}.`);
    }

    if (dest.length === 0) {
      throw new Error(`${DEST_ERROR}, but got '' (empty string).`);
    }

    if (options !== undefined) {
      if (!isPlainObj(options)) {
        throw new TypeError(`Expected an object to specify \`dl-tar\` options, but got ${inspect(options)}.`);
      }
    } else {
      options = {};
    }

    if (options.method) {
      const formattedMethod = inspect(options.method);

      if (formattedMethod.toLowerCase() !== '\'get\'') {
        throw new (typeof options.method === 'string' ? Error : TypeError)(
          'Invalid `method` option: ' +
          formattedMethod +
          '. `dl-tar` module is designed to download archive files. ' +
          'So it only supports the default request method "GET" and it cannot be overridden by `method` option.'
        );
      }
    }

    if (options.tarTransform !== undefined) {
      if (!isStream(options.tarTransform)) {
        throw new TypeError(`${TAR_TRANSFORM_ERROR}, but got a non-stream value ${inspect(options.tarTransform)}.`);
      }

      if (!isStream.transform(options.tarTransform)) {
        throw new TypeError(`${TAR_TRANSFORM_ERROR}, but got a ${
          ['duplex', 'writable', 'readable'].find(type => isStream[type](options.tarTransform))
        } stream instead.`);
      }
    }

    if (options.mapStream !== undefined && typeof options.mapStream !== 'function') {
      throw new TypeError(`\`mapStream\` option must be a function, but got ${inspect(options.mapStream)}.`);
    }

    if (options.strip !== undefined) {
      if (typeof options.strip !== 'number') {
        throw new TypeError(`${STRIP_ERROR}, but got a non-number value ${inspect(options.strip)}.`);
      }

      if (!isFinite(options.strip)) {
        throw new RangeError(`${STRIP_ERROR}, but got ${options.strip}.`);
      }

      if (options.strip > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`${STRIP_ERROR}, but got a too large number.`);
      }

      if (options.strip < 0) {
        throw new RangeError(`${STRIP_ERROR}, but got a negative number ${options.strip}.`);
      }

      if (!Number.isInteger(options.strip)) {
        throw new Error(`${STRIP_ERROR}, but got a non-integer number ${options.strip}.`);
      }
    }

    const mapStream = options.mapStream || echo;
    const fileStreams = [];
    let responseHeaders;
    let responseBytes = 0;

    const extractStream = extract(dest, Object.assign({
      fs: gracefulFs,
      strip: 1
    }, options, {
      mapStream(fileStream, header) {
        const newStream = mapStream(fileStream, header);

        if (!isStream.readable(newStream)) {
          extractStream.emit(
            'error',
            new TypeError(`${MAP_STREAM_ERROR}${
              isStream(newStream) ?
              ' that is readable, but returned a non-readable stream' :
              `, but returned a non-stream value ${inspect(newStream)}`
            }.`)
          );

          fileStreams.push(fileStream);
          return new PassThrough();
        }

        let bytes = 0;
        fileStreams.push(newStream);

        return newStream.pipe(new Transform({
          transform(chunk, encoding, cb) {
            bytes += chunk.length;

            observer.next({
              entry: {header, bytes},
              response: {
                headers: responseHeaders,
                bytes: responseBytes
              }
            });

            cb(null, chunk);
          }
        }));
      }
    }));

    loadRequestFromCwdOrNpm().then(request => {
      const pipe = [
        request(Object.assign({url}, options, priorOption))
        .on('response', function(response) {
          if (response.statusCode < 200 || 299 < response.statusCode) {
            this.emit('error', new Error(`${response.statusCode} ${response.statusMessage}`));
            return;
          }

          responseHeaders = response.headers;
        }),
        new Transform({
          transform(chunk, encoding, cb) {
            responseBytes += chunk.length;
            cb(null, chunk);
          }
        }),
        extractStream
      ];

      if (options.tarTransform) {
        pipe.splice(2, 0, options.tarTransform);
      }

      pump(pipe, err => {
        if (err) {
          observer.error(err);
          return;
        }

        observer.complete();
      });
    }).catch(err => observer.error(err));

    return function cancelExtract() {
      for (const fileStream of fileStreams) {
        fileStream.unpipe();
      }
    };
  });
};
