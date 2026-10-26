// The doctor's Spaces section: silent without cua or a bot that has the spaces tools, and otherwise one plain
// line each for cua, gVisor and the firewall unit. The commands are fakes; the real cua and systemctl never run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runDoctor } from "../../src/core/doctor.ts";
import { CuaMissing, type CuaRun } from "../../src/spaces/cua.ts";
import { containerRuntime, type SpacesProbe, spacesFindings } from "../../src/spaces/check.ts";
import { tempDir, testConfig, testCore } from "../helpers.ts";

const GVISOR = "container  ok           [NativeLinux] unix:///var/run/docker.sock with gVisor (runsc)\nqemu       ok  /usr/bin/qemu\n";
const RUNC = "container  ok           [NativeLinux] unix:///var/run/docker.sock without runsc: containers run with runc unless runsc is installed; run `cua runtime setup runsc`\n";

const cua = (doctor: string, version = "cua 0.9.0\n"): CuaRun => async (args) => (args[0] === "--version" ? { code: 0, stdout: version, stderr: "" } : { code: 0, stdout: doctor, stderr: "" });
const missing: CuaRun = async () => {
	throw new CuaMissing();
};
const systemctl = (state: string, code = 0): CuaRun => async () => ({ code, stdout: `${state}\n`, stderr: "" });

test("the container line says whether gVisor is in use", () => {
	assert.equal(containerRuntime(GVISOR), "gvisor");
	assert.equal(containerRuntime(RUNC), "runc");
	assert.equal(containerRuntime("container  fail  docker is not running"), "failing");
	assert.equal(containerRuntime("something else"), "unknown");
});

test("nothing is said about spaces without cua or a bot that uses them", async () => {
	assert.deepEqual(await spacesFindings({ cua: missing, systemctl: systemctl("active"), platform: "linux" }, false), []);
});

test("a healthy host gets three ok lines", async () => {
	const f = await spacesFindings({ cua: cua(GVISOR), systemctl: systemctl("active"), platform: "linux" }, false);
	assert.deepEqual(f.map((x) => x.level), ["ok", "ok", "ok"]);
	assert.match(f[0]!.text, /cua 0\.9\.0 runs/);
	assert.match(f[1]!.text, /gVisor/);
	assert.match(f[2]!.text, /nhermes-spaces-firewall.*active/);
});

test("runc only, an inactive firewall and a missing cua are warnings that say what to do", async () => {
	const f = await spacesFindings({ cua: cua(RUNC), systemctl: systemctl("inactive", 3), platform: "linux" }, false);
	assert.deepEqual(f.map((x) => x.level), ["ok", "warn", "warn"]);
	assert.match(f[1]!.text, /runc.*docs\/SPACES\.md/);
	assert.match(f[2]!.text, /inactive.*deploy\/nhermes-spaces-firewall\.service/);
	const none = await spacesFindings({ cua: missing, systemctl: systemctl("active"), platform: "linux" }, true);
	assert.match(none[0]!.text, /not installed/);
	assert.equal(none[0]!.level, "warn");
	assert.equal(none.length, 2, "no runtime check without cua");
});

test("without systemd the firewall cannot be checked, and a cua that hangs or fails is a warning", async () => {
	const mac = await spacesFindings({ cua: cua(GVISOR), systemctl: missing, platform: "darwin" }, false);
	assert.match(mac.at(-1)!.text, /cannot be checked/);
	const noSystemd = await spacesFindings({ cua: cua(GVISOR), systemctl: missing, platform: "linux" }, false);
	assert.match(noSystemd.at(-1)!.text, /no systemctl/);
	const stuck: CuaRun = async (args) => (args[0] === "--version" ? { code: 0, stdout: "cua 0.9.0", stderr: "" } : { code: 1, stdout: "", stderr: "" });
	const f = await spacesFindings({ cua: stuck, systemctl: systemctl("active"), platform: "linux" }, false);
	assert.match(f[1]!.text, /could not tell/);
	const broken: CuaRun = async () => ({ code: 1, stdout: "", stderr: "boom" });
	assert.match((await spacesFindings({ cua: broken, systemctl: systemctl("active"), platform: "linux" }, false))[0]!.text, /did not answer/);
});

test("the doctor shows the section for a bot with the spaces tools, and its exit code stays 0 for warnings", async () => {
	const { dir, cleanup } = await tempDir();
	const core = await testCore(dir, { config: testConfig(dir, [{ name: "main", default: true, tools: ["spaces"] }]) });
	try {
		const report = await runDoctor(core, { cua: missing, systemctl: systemctl("active"), platform: "linux" });
		const line = report.lines.find((l) => l.includes("Spaces:"));
		assert.match(line ?? "", /^! Spaces: a bot has the spaces tools/);
		assert.ok(report.findings.filter((f) => f.level === "fail").every((f) => !f.text.includes("Spaces")));
	} finally {
		await core.close();
		await cleanup();
	}
});
