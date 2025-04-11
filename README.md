# `@lib/zip`

**WORK IN PROGRESS**

Compress and decompress Zip archives in Node and browsers, without dependencies.

Install:

```bash
npm install --save @lib/zip
```

## API

***ƒ*** `encode(files: EncodeEntry[]): Promise<Uint8Array>`

Compress or store list of files into a Zip archive.

***ƒ*** `decode(compressed: Uint8Array, filter?: (entry: ScanEntry) => string | boolean): Promise<DecodeEntry[]>`

Decompress Zip archive into a list of files, with optional filter callback to skip or rename files.

**Ⓔ** `ZipMethod`

- `STORE` File stored without compression. Best for images etc.
- `DEFLATE` File compressed with the same algorithm as gzip.

**Ⓘ** `EncodeEntry`

Information about a file to be compressed.

- `data` File contents as string or `Uint8Array` binary data.
- `path` File path as stored in archive.
- *`method`* Optional compression method, one of `ZipMethod`.
}

**Ⓘ** `ScanEntry`

Information about a compressed file, for filtering whether to decompress it.

- `path` File path as stored in archive.
- `decodedSize` Valid size after decompression.
- `encodedSize` Compressed size occupied inside archive.
- `method` Compression method, one of `ZipMethod`.

**Ⓘ** `DecodeEntry`

Information about a file after decompressing it. Same as `ScanEntry`, with an extra field:

- `data` File contents as `Uint8Array` binary data.

# License

0BSD, which means use as you wish and no need to mention this project or its author. Consider it public domain in practice.
