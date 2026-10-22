// The panel's entry point: loads each screen (each registers its tab; the import order is the tab order)
// and starts the shell. See core.js for how to add a tab.
import { route, run, start } from "./core.js";
import "./bots.js";
import "./network.js";
import "./sessions.js";
import "./memory.js";
import "./keys.js";
import "./logins.js";
import "./mcp.js";
import "./status.js";
import "./gateway.js";

window.addEventListener("hashchange", route);
run(start);
