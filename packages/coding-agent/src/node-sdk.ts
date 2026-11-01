import "./node-platform";
import { initializeNodeSdk } from "./node-bootstrap";

export * from "./headless";

initializeNodeSdk(import.meta.url);
