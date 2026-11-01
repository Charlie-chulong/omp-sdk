import { createHash, createHmac, getHashes, type BinaryToTextEncoding, type Hash, type Hmac } from "node:crypto";
import { hashBytes, type HashInput } from "./runtime-hash";

const hashByteLengths = new Map<string, number>();

class NodeCryptoHash {
	readonly algorithm: string;
	readonly byteLength: number;
	readonly #key: string | Uint8Array | undefined;
	#hash: Hash | Hmac;
	#hmacChunks: Buffer[] | undefined;
	constructor(algorithm: string, hmacKey?: string | Uint8Array) {
		this.algorithm = algorithm;
		this.#key = hmacKey;
		this.#hash = hmacKey === undefined ? createHash(algorithm) : createHmac(algorithm, hmacKey);
		let byteLength = hashByteLengths.get(algorithm);
		if (byteLength === undefined) {
			byteLength = createHash(algorithm).digest().length;
			hashByteLengths.set(algorithm, byteLength);
		}
		this.byteLength = byteLength;
		if (hmacKey !== undefined) this.#hmacChunks = [];
	}
	update(input: HashInput, inputEncoding?: BufferEncoding): this {
		if (typeof input === "string") this.#hash.update(input, inputEncoding);
		else this.#hash.update(hashBytes(input));
		// OpenSSL does not expose HMAC state cloning; retain only HMAC inputs for copy().
		if (this.#hmacChunks)
			this.#hmacChunks.push(
				typeof input === "string" ? Buffer.from(input, inputEncoding) : Buffer.from(hashBytes(input)),
			);
		return this;
	}
	copy(): NodeCryptoHasher {
		const copy = new NodeCryptoHasher(this.algorithm, this.#key);
		if (this.#hmacChunks) {
			for (const chunk of this.#hmacChunks) copy.update(chunk);
		} else copy.#hash = (this.#hash as Hash).copy();
		return copy;
	}
	digest(): Buffer;
	digest(encoding: BinaryToTextEncoding): string;
	digest<T extends ArrayBufferView>(into: T): T;
	digest(encoding?: BinaryToTextEncoding | ArrayBufferView): Buffer | string | ArrayBufferView {
		const bytes = this.#hash.digest();
		this.#hash = this.#key === undefined ? createHash(this.algorithm) : createHmac(this.algorithm, this.#key);
		if (this.#hmacChunks) this.#hmacChunks.length = 0;
		if (typeof encoding === "string") return bytes.toString(encoding);
		if (encoding) {
			if (encoding.byteLength < bytes.length) throw new RangeError("Hash destination is too small");
			new Uint8Array(encoding.buffer, encoding.byteOffset, encoding.byteLength).set(bytes);
			return encoding;
		}
		return bytes;
	}
}

export class NodeCryptoHasher extends NodeCryptoHash {
	static hash(algorithm: string, input: HashInput): Buffer;
	static hash(algorithm: string, input: HashInput, encoding: BinaryToTextEncoding): string;
	static hash<T extends ArrayBufferView>(algorithm: string, input: HashInput, into: T): T;
	static hash(
		algorithm: string,
		input: HashInput,
		encoding?: BinaryToTextEncoding | ArrayBufferView,
	): Buffer | string | ArrayBufferView {
		const hasher = new NodeCryptoHasher(algorithm).update(input);
		if (typeof encoding === "string") return hasher.digest(encoding);
		if (encoding) return hasher.digest(encoding);
		return hasher.digest();
	}
	static readonly algorithms = getHashes();
}

export class NodeSHA256 extends NodeCryptoHash {
	constructor() {
		super("sha256");
	}
	static readonly byteLength = 32;
	static hash(input: HashInput): Buffer;
	static hash(input: HashInput, encoding: BinaryToTextEncoding): string;
	static hash<T extends ArrayBufferView>(input: HashInput, into: T): T;
	static hash(input: HashInput, encoding?: BinaryToTextEncoding | ArrayBufferView): Buffer | string | ArrayBufferView {
		const hasher = new NodeSHA256().update(input);
		if (typeof encoding === "string") return hasher.digest(encoding);
		if (encoding) return hasher.digest(encoding);
		return hasher.digest();
	}
}
