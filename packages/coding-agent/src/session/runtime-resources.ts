/** Live resources owned by an SDK session; retained kernels contain non-persisted variables. */
export interface RuntimeResource {
	id: string;
	kind: "python_kernel" | "javascript_kernel" | "shell" | "helper";
	ownerSessionId: string;
	ownerAgentId?: string;
	pid?: number;
	state: "starting" | "running" | "retained" | "stopping";
	retentionReasons: string[];
	liveHandles: number;
	releasable: boolean;
}
