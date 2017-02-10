# dl-tar

[![NPM version](https://img.shields.io/npm/v/dl-tar.svg)](https://www.npmjs.com/package/dl-tar)
[![Build Status](https://travis-ci.org/shinnn/dl-tar.svg?branch=master)](https://travis-ci.org/shinnn/dl-tar)
[![Build status](https://ci.appveyor.com/api/projects/status/83sbr9dtbp3hreoy/branch/master?svg=true)](https://ci.appveyor.com/project/ShinnosukeWatanabe/dl-tar/branch/master)
[![Coverage Status](https://img.shields.io/coveralls/shinnn/dl-tar.svg)](https://coveralls.io/github/shinnn/dl-tar?branch=master)

A [Node.js](https://nodejs.org/) module to download and extract a [tar](https://www.gnu.org/software/tar/) archive with [Observable](https://tc39.github.io/proposal-observable/) API

```javascript
const {readdirSync} = require('fs');
const dlTar = require('dl-tar');

const url = 'https://****.org/my-archive.tar';
/* my-archive
   ├── LICENSE
   ├── README.md
   ├── INSTALL
   └── bin
       └── app.exe
*/

dlTar(url, 'my/dir').subscribe({
  next({header, bytes}) {
    if (bytes !== header.size) {
      return;
    }

    console.log(`✓ ${header.name}`);
  },
  complete() {
    readdirSync('my/dir'); //=> ['INSTALL', LICENSE', 'README.md', 'bin']

    console.log('\nCompleted.')
  }
});
```

```
✓ bin/app.exe
✓ README.md
✓ LICENSE
✓ install

Completed.
```

## Installation

[Use npm.](https://docs.npmjs.com/cli/install)

```
npm install dl-tar
```

## API

```javascript
const dlTar = require('dl-tar');
```

### dlTar(*tarArchiveUrl*, *extractDir* [, *options*])

*tarArchiveUrl*: `String`  
*extractDir*: `String` (a path where the archive will be extracted)  
*options*: `Object`  
Return: [`Observable`](http://www.ecma-international.org/ecma-262/6.0/#sec-promise-constructor) ([zenparsing's implementation](https://github.com/zenparsing/zen-observable))

When the observable is [subscribe](https://tc39.github.io/proposal-observable/#observable-prototype-subscribe)d, it starts to download the tar archive, extract it and successively send extraction progress as objects to the observer.

Every progress object have two properties `header` and `bytes`. `bytes` is the total size of currently extracted entry, and `header` is [a header of the entry](https://github.com/mafintosh/tar-stream#headers).

For example you can get the progress of each entry as a percentage by `bytes / header.size * 100`.

```javascript
dlTar('https://****.org/my-archive.tar', 'my/dir').subscribe(progress => {
  console.log(`${(progress.bytes / progress.header.size * 100).toFixed(1)} %`);

  if (progress.bytes === progress.header.size) {
    console.log(`>> OK ${progress.header.name}\n`);
  }
});
```

```
0.1 %
0.3 %
0.4 %
[...]
99.6 %
99.8 %
99.9 %
100.0 %
>> OK bin/app.exe
0.1 %
0.2 %
0.3 %
[...]
```

#### Options

You can pass options to [Request](https://github.com/request/request#requestoptions-callback) and [tar-fs](https://github.com/mafintosh/tar-fs)'s [`extract`](https://github.com/mafintosh/tar-fs/blob/12968d9f650b07b418d348897cd922e2b27ec18c/index.js#L167).

Note that [`strip` option](https://github.com/mafintosh/tar-fs/blob/12968d9f650b07b418d348897cd922e2b27ec18c/index.js#L47) defaults to `1`, not `0`. That means the top level directory is stripped off by default.

Additionally, you can use the following option.

##### tarTransform

Type: [`Stream`](https://nodejs.org/api/stream.html#stream_stream)

A [transform stream](https://nodejs.org/api/stream.html#stream_class_stream_transform) to modify the archive before extraction.

For example, pass [gunzip-maybe](https://github.com/mafintosh/gunzip-maybe) to this option and you can download both [gzipped](https://tools.ietf.org/html/rfc1952) and non-gzipped tar.

```javascript
const dlTar = require('dl-tar');
const gunzipMaybe = require('gunzip-maybe');

const observable = dlTar('https://github.com/nodejs/node/archive/master.tar.gz', './', {
  tarTransform: gunzipMaybe()
});
```

## License

Copyright (c) 2017 [Shinnosuke Watanabe](https://github.com/shinnn)

Licensed under [the MIT License](./LICENSE).
