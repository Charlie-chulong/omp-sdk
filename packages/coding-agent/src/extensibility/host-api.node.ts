import * as HeadlessApi from "../headless";

/** Extensions share the same headless SDK module instances as their Node host. */
export function getCodingAgentApi(): typeof HeadlessApi {
	return HeadlessApi;
}
