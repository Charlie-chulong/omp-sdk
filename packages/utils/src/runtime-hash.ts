export type HashInput = string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer;

export function hashBytes(input: HashInput): Buffer {
	if (typeof input === "string") return Buffer.from(input);
	if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	return Buffer.from(input);
}

/** Bun compression requires ordinary ArrayBuffer storage; retain views when already compatible. */
export function nonSharedBytes(input: HashInput): Buffer<ArrayBuffer> {
	const bytes = hashBytes(input);
	if (bytes.buffer instanceof ArrayBuffer) return bytes as Buffer<ArrayBuffer>;
	return Buffer.from(bytes);
}

const MASK64 = 0xffffffffffffffffn;
const WY = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n];
function mix(a: bigint, b: bigint): bigint {
	const product = a * b;
	return (product & MASK64) ^ (product >> 64n);
}

/** The wyhash final-v4 algorithm used by Zig std.hash.Wyhash and Bun.hash. */
export function wyhash(input: HashInput, seed: number | bigint = 0n): bigint {
	const bytes = hashBytes(input);
	const length = bytes.length;
	let state = BigInt.asUintN(64, BigInt(seed));
	state ^= mix(state ^ WY[0], WY[1]);
	let a = 0n;
	let b = 0n;
	if (length <= 16) {
		if (length >= 4) {
			const quarter = (length >> 3) << 2;
			a = (BigInt(bytes.readUInt32LE(0)) << 32n) | BigInt(bytes.readUInt32LE(quarter));
			b = (BigInt(bytes.readUInt32LE(length - 4)) << 32n) | BigInt(bytes.readUInt32LE(length - 4 - quarter));
		} else if (length > 0) {
			a = BigInt((bytes[0] << 16) | (bytes[length >> 1] << 8) | bytes[length - 1]);
		}
	} else {
		let offset = 0;
		if (length >= 48) {
			let state1 = state;
			let state2 = state;
			while (offset + 48 < length) {
				state = mix(bytes.readBigUInt64LE(offset) ^ WY[1], bytes.readBigUInt64LE(offset + 8) ^ state);
				state1 = mix(bytes.readBigUInt64LE(offset + 16) ^ WY[2], bytes.readBigUInt64LE(offset + 24) ^ state1);
				state2 = mix(bytes.readBigUInt64LE(offset + 32) ^ WY[3], bytes.readBigUInt64LE(offset + 40) ^ state2);
				offset += 48;
			}
			state ^= state1 ^ state2;
		}
		while (offset + 16 < length) {
			state = mix(bytes.readBigUInt64LE(offset) ^ WY[1], bytes.readBigUInt64LE(offset + 8) ^ state);
			offset += 16;
		}
		a = bytes.readBigUInt64LE(length - 16);
		b = bytes.readBigUInt64LE(length - 8);
	}
	const product = (a ^ WY[1]) * (b ^ state);
	return mix((product & MASK64) ^ WY[0] ^ BigInt(length), (product >> 64n) ^ WY[1]);
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	return value >>> 0;
});
export function crc32(input: HashInput, seed = 0): number {
	let value = (seed ^ 0xffffffff) >>> 0;
	for (const byte of hashBytes(input)) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 255];
	return (value ^ 0xffffffff) >>> 0;
}

const P32 = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f, 0x165667b1];
const rot32 = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
const round32 = (value: number, input: number) => Math.imul(rot32((value + Math.imul(input, P32[1])) | 0, 13), P32[0]);
export function xxHash32(input: HashInput, seed = 0): number {
	const bytes = hashBytes(input);
	let offset = 0;
	let value: number;
	if (bytes.length >= 16) {
		let a = (seed + P32[0] + P32[1]) | 0;
		let b = (seed + P32[1]) | 0;
		let c = seed | 0;
		let d = (seed - P32[0]) | 0;
		while (offset <= bytes.length - 16) {
			a = round32(a, bytes.readUInt32LE(offset));
			b = round32(b, bytes.readUInt32LE(offset + 4));
			c = round32(c, bytes.readUInt32LE(offset + 8));
			d = round32(d, bytes.readUInt32LE(offset + 12));
			offset += 16;
		}
		value = (rot32(a, 1) + rot32(b, 7) + rot32(c, 12) + rot32(d, 18)) | 0;
	} else value = (seed + P32[4]) | 0;
	value = (value + bytes.length) | 0;
	while (offset + 4 <= bytes.length) {
		value = Math.imul(rot32((value + Math.imul(bytes.readUInt32LE(offset), P32[2])) | 0, 17), P32[3]);
		offset += 4;
	}
	while (offset < bytes.length) value = Math.imul(rot32((value + Math.imul(bytes[offset++], P32[4])) | 0, 11), P32[0]);
	value ^= value >>> 15;
	value = Math.imul(value, P32[1]);
	value ^= value >>> 13;
	value = Math.imul(value, P32[2]);
	return (value ^ (value >>> 16)) >>> 0;
}

const P64 = [0x9e3779b185ebca87n, 0xc2b2ae3d27d4eb4fn, 0x165667b19e3779f9n, 0x85ebca77c2b2ae63n, 0x27d4eb2f165667c5n];
const u64 = (value: bigint) => value & MASK64;
const rot64 = (value: bigint, bits: bigint) => u64((value << bits) | (value >> (64n - bits)));
const round64 = (value: bigint, input: bigint) => u64(rot64(u64(value + input * P64[1]), 31n) * P64[0]);
export function xxHash64(input: HashInput, seed: number | bigint = 0n): bigint {
	const bytes = hashBytes(input);
	const initial = BigInt.asUintN(64, BigInt(seed));
	let offset = 0;
	let value: bigint;
	if (bytes.length >= 32) {
		let a = u64(initial + P64[0] + P64[1]);
		let b = u64(initial + P64[1]);
		let c = initial;
		let d = u64(initial - P64[0]);
		while (offset <= bytes.length - 32) {
			a = round64(a, bytes.readBigUInt64LE(offset));
			b = round64(b, bytes.readBigUInt64LE(offset + 8));
			c = round64(c, bytes.readBigUInt64LE(offset + 16));
			d = round64(d, bytes.readBigUInt64LE(offset + 24));
			offset += 32;
		}
		value = u64(rot64(a, 1n) + rot64(b, 7n) + rot64(c, 12n) + rot64(d, 18n));
		for (const lane of [a, b, c, d]) value = u64((value ^ round64(0n, lane)) * P64[0] + P64[3]);
	} else value = u64(initial + P64[4]);
	value = u64(value + BigInt(bytes.length));
	while (offset + 8 <= bytes.length) {
		value = u64(rot64(value ^ round64(0n, bytes.readBigUInt64LE(offset)), 27n) * P64[0] + P64[3]);
		offset += 8;
	}
	if (offset + 4 <= bytes.length) {
		value = u64(rot64(value ^ u64(BigInt(bytes.readUInt32LE(offset)) * P64[0]), 23n) * P64[1] + P64[2]);
		offset += 4;
	}
	while (offset < bytes.length) value = u64(rot64(value ^ u64(BigInt(bytes[offset++]) * P64[4]), 11n) * P64[0]);
	value ^= value >> 33n;
	value = u64(value * P64[1]);
	value ^= value >> 29n;
	value = u64(value * P64[2]);
	return value ^ (value >> 32n);
}
