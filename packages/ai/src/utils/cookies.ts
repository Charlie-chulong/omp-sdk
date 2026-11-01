import { parseString } from "set-cookie-parser";

/** Name/value storage matching the HTTP OTP flow's native CookieMap use. */
export class CookieMap extends Map<string, string> {}
export class Cookie {
	constructor(
		readonly name: string,
		readonly value: string,
		readonly expires?: Date,
		readonly maxAge?: number,
	) {}
	static parse(value: string): Cookie {
		const parsed = parseString(value);
		return new Cookie(parsed.name, parsed.value, parsed.expires, parsed.maxAge);
	}
	isExpired(): boolean {
		return (
			(this.maxAge !== undefined && this.maxAge <= 0) ||
			(this.expires !== undefined && this.expires.getTime() <= Date.now())
		);
	}
}
