/** General purpose bit flags, documented for interest. */
export const enum ZipFlag {
	/** If set, file contents are encrypted. */
	ENCRYPT = 1,

	/** If set, CRC and sizes go in a descriptor section after file
	  * contents, which were probably of unknown size prior to streaming
	  * directly from elsewhere. */
	STREAM = 1 << 3,

	/** Language encoding flag (EFS) if set, means file name and contents are encoded in UTF-8. */
	UTF8 = 1 << 11
}

/** Compression methods (partial list). */
export enum ZipMethod {
	STORE = 0,
	DEFLATE = 8,

	/** Unsupported. */
	LZMA = 14
}

/** Operating system used to generate the archive (partial list). */
export const enum ZipOS {
	DOS = 0,
	UNIX = 3,
	NTFS = 11,
	VFAT = 14,
	OSX = 19
}

/** File attributes for compression software internal use. */
export const enum ZipAttr {
	BINARY = 0,
	TEXT = 1
}

/** POSIX file type (partial list). */
export const enum ZipPosix {
	FIFO = 1,
	DIRECTORY = 4,
	FILE = 8,
	SYMLINK = 10,
	SOCKET = 12
}

/** Magic numbers to identify file sections. */
export const enum ZipMagic {
	START = 0x04034b50,
	ITEM = 0x02014b50,
	END = 0x06054b50
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isBigEndian = (() => {
	const u8 = new Uint8Array([1, 2]);
	return new Uint16Array(u8.buffer)[0] == 0x0102;
})();

/** Mutate array of u16 if necessary, to ensure it's little endian. */

function makeLittleEndian(u16: Uint16Array): void {
	if(isBigEndian) {
		const len = u16.length;

		for(let i = 0; i < len; i++) {
			const n = u16[i];
			u16[i] = (n << 8) | (n >> 8);
		}
	}
}

/** Make a Uint16Array view into a buffer at offset,
  * except copy the data if offset is unaligned.
  *
  * @param offset Byte offset
  * @param length Output array length (number of u16's) */

function subarrayU16(buffer: ArrayBuffer, offset: number, length?: number) {
	if(offset & 1) {
		buffer = length ? buffer.slice(offset, offset + length * 2) : buffer.slice(offset);
		return new Uint16Array(buffer);
	}

	return new Uint16Array(buffer, offset, length);
}

export async function deflate(raw: Uint8Array, chunks: Uint8Array[]): Promise<[number, number]> {
	// Compress as gzip to get DEFLATE-compressed data and CRC-32 checksum.
	const stream = new CompressionStream('gzip');
	const writer = (stream.writable as WritableStream<Uint8Array>).getWriter();
	await writer.write(raw);
	await writer.close();

	const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
	let first = chunks.length;
	let chunk: Uint8Array;
	let result: ReadableStreamReadResult<any>;
	let size = 0;

	while(!(result = await reader.read()).done) {
		chunk = result.value;
		chunks.push(chunk);
		size += result.value.length;
	}

	// Skip gzip header.
	let trimTotal = 10;
	while(trimTotal > 0 && first < chunks.length) {
		chunk = chunks[first];

		const trim = Math.min(trimTotal, chunk.length);
		chunks[first++] = chunk.subarray(trim);
		trimTotal -= trim;
	}

	chunk = chunks[chunks.length - 1];
	const u16 = subarrayU16(chunk.buffer, chunk.length - 8);
	chunks[chunks.length - 1] = chunk.subarray(0, chunk.length - 8);

	makeLittleEndian(u16);

	// Work around bug, CRC-32 for no data should be zero.
	const crc32 = raw.length && (u16[1] << 16) + u16[0];
	size -= 18;

	return [size, crc32];
}

const gzipHeader = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0]);

export async function inflate(compressed: Uint8Array, crc32: number, decodedSize: number): Promise<Uint8Array> {
	// Decompress as gzip to also verify CRC-32 checksum.
	const stream = new DecompressionStream('gzip');
	const writer = (stream.writable.getWriter());

	// Write valid gzip header and data to decompress.
	writer.write(gzipHeader);
	writer.write(compressed);

	// Write gzip footer with CRC-32 checksum and expected size for verification.
	const u16 = new Uint16Array([crc32, crc32 >> 16, decodedSize, decodedSize >> 16]);
	makeLittleEndian(u16);

	writer.write(new Uint8Array(u16.buffer));
	writer.close();

	const chunks: Uint8Array[] = [];
	const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
	let result: ReadableStreamReadResult<any>;
	let size = 0;

	while(!(result = await reader.read()).done) {
		chunks.push(result.value);
		size += result.value.length;
	}

	const raw = new Uint8Array(size);
	size = 0;

	for(const chunk of chunks) {
		raw.set(chunk, size);
		size += chunk.length;
	}

	return raw;
}

export interface EncodeEntry {
	data: string | Uint8Array;
	path: string;
	stamp?: number;
	method?: ZipMethod;
}

export interface ScanEntry {
	path: string;
	decodedSize: number;
	encodedSize: number;
	stamp: number;
	method: ZipMethod;
}

export interface DecodeEntry extends ScanEntry {
	data: Uint8Array;
}

const empty = new Uint8Array(0);

export async function encode(files: EncodeEntry[]): Promise<Uint8Array> {
	const defaultDate = new Date();
	const mode = 0o644;
	const chunks: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	let contentSize = 0;
	let directorySize = 0;
	let count = 0;

	for(const entry of files) {
		const name = textEncoder.encode(entry.path);
		const date = typeof entry.stamp == 'number' ? new Date(entry.stamp) : defaultDate;
		let raw = entry.data;

		if(typeof raw == 'string') raw = textEncoder.encode(raw);

		const first = chunks.length;
		const decodedSize = raw.length;
		const u16 = new Uint16Array(25);
		const u8 = new Uint8Array(u16.buffer);

		chunks.push(empty, name);
		let method = entry.method;
		// TODO: If we STORE without trying DEFLATE first, how to best calculate CRC32?
		method = ZipMethod.DEFLATE;
		let [encodedSize, crc32] = await deflate(raw, chunks);

		// If compression saves at most a few bytes or percent, don't compress.
		if(encodedSize > decodedSize + 8 || encodedSize / (decodedSize + 1) > 0.98) method = ZipMethod.STORE;

		if(method == ZipMethod.STORE) {
			chunks[first + 2] = raw;
			chunks.length = first + 3;
			method = ZipMethod.STORE;
			encodedSize = decodedSize;
		}

		// Local file header.
		u16[0] = ZipMagic.START;
		u16[1] = ZipMagic.START >> 16;
		u16[2] = 10; // Version
		u16[3] = ZipFlag.UTF8;
		u16[4] = method;
		// DOS internal date encoding format (accurate only to 2 seconds) lives on, here.
		u16[5] = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
		u16[6] = (date.getFullYear() - 1980 << 9) | (date.getMonth() + 1 << 5) | date.getDate();
		u16[7] = crc32;
		u16[8] = crc32 >> 16;
		u16[9] = encodedSize;
		u16[10] = encodedSize >> 16;
		u16[11] = decodedSize;
		u16[12] = decodedSize >> 16;
		u16[13] = name.length;
		u16[14] = 0; // Length of extra data.

		// Central directory file header.
		u16[15] = ZipMagic.ITEM;
		u16[16] = ZipMagic.ITEM >> 16;
		u16[17] = (ZipOS.UNIX << 8) + 10;
		// -- Copy of local file header (without magic) inserted here --
		u16[18] = 0;
		u16[19] = 0;
		u16[20] = ZipAttr.BINARY;
		u16[21] = 0;
		u16[22] = (ZipPosix.FILE << 12) | mode;
		u16[23] = contentSize;
		u16[24] = contentSize >> 16;

		makeLittleEndian(u16);

		// Write local file header in previous chunk emitted before compressed contents.
		chunks[first] = u8.subarray(0, 30);
		contentSize += 30 + name.length + encodedSize;

		// Write central directory file header with local file header in the middle.
		directory.push(u8.subarray(30, 36), u8.subarray(4, 30), u8.subarray(36, 50), name);
		directorySize += 46 + name.length;
		++count;
	}

	const u16 = new Uint16Array(11);
	const footer = new Uint8Array(u16.buffer);

	// End of central directory record.
	u16[0] = ZipMagic.END;
	u16[1] = ZipMagic.END >> 16;
	u16[2] = 0;
	u16[3] = 0;
	u16[4] = count;
	u16[5] = count;
	u16[6] = directorySize;
	u16[7] = directorySize >> 16;
	u16[8] = contentSize;
	u16[9] = contentSize >> 16;
	u16[10] = 0;

	makeLittleEndian(u16);

	const compressed = new Uint8Array(contentSize + directorySize + footer.length);
	contentSize = 0;

	for(const part of [chunks, directory, [footer]]) {
		for(const chunk of part) {
			compressed.set(chunk, contentSize);
			contentSize += chunk.length;
		}
	}

	return compressed;
}

export async function decode(compressed: Uint8Array, filter?: (entry: ScanEntry) => string | boolean): Promise<DecodeEntry[]> {
	const entries: DecodeEntry[] = [];
	const broken = 'Broken zip file';
	const len = compressed.length;
	let count = 0;
	let pos = 0;

	while(pos + 30 < len) {
		const u16 = subarrayU16(compressed.buffer, pos, 15);
		makeLittleEndian(u16);

		if((u16[1] << 16) + u16[0] == ZipMagic.ITEM) break;
		if((u16[1] << 16) + u16[0] != ZipMagic.START) throw new Error(broken);

		// TODO: Decode stamp.
		const method = u16[4];
		const encodedSize = (u16[10] << 16) | u16[9];
		const decodedSize = (u16[12] << 16) | u16[11];
		const nameLen = u16[13];
		const extraLen = u16[14];
		pos += 30;

		const path = textDecoder.decode(compressed.subarray(pos, pos + nameLen));
		const entry: ScanEntry = { path, encodedSize, decodedSize, stamp: 0, method };
		pos += nameLen + extraLen;

		if(!filter || filter(entry)) {
			if(
				u16[2] > 20 ||
				(u16[3] & ZipFlag.ENCRYPT) ||
				(method != ZipMethod.STORE && method != ZipMethod.DEFLATE)
			) {
				throw new Error('Unsupported compression method for: ' + path);
			}

			const crc32 = (u16[8] << 16) | u16[7];

			let raw = compressed.subarray(pos, pos + encodedSize);
			if(method == ZipMethod.DEFLATE) raw = await inflate(raw, crc32, decodedSize);

			(entry as DecodeEntry).data = raw;
			entries.push(entry as DecodeEntry);
		}

		pos += encodedSize;
		++count;
	}

	// Check that central directory is valid.
	/* while(count--) {
		const u16 = subarrayU16(compressed.buffer, pos, 23);
		makeLittleEndian(u16);

		if((u16[1] << 16) + u16[0] != ZipMagic.ITEM) {
			console.log(u16, ZipMagic.ITEM);
			// throw new Error(broken);
			return content;
		}
		const nameLen = u16[14];

		pos += 46;

		const path = textDecoder.decode(compressed.subarray(pos, pos + nameLen));
		pos += nameLen;
	}

	// Verify end of central directory record to ensure zip file is complete.
	const u16 = subarrayU16(compressed.buffer, pos, 10);
	makeLittleEndian(u16);

	if((u16[1] << 16) + u16[0] != ZipMagic.END) throw new Error(broken); */

	return entries;
}
