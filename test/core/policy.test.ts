import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../../src/core/policy.ts";

const bot = (trusted: boolean, mode: "smart" | "manual" | "off" = "smart") =>
	({ name: "b", trusted, approvals: { mode, ask: [], deny: ["tool:forbidden"], allow: [] } }) as never;
const pc = (trusted: boolean, mode: "smart" | "manual" | "off" = "smart", extra = {}) => ({ bot: bot(trusted, mode), sessionRules: [], botRules: [], yolo: false, ...extra });
const bash = (command: string) => ({ name: "bash", arguments: { command } });

test("smart mode asks for high-impact commands and lets routine ones run", () => {
	assert.equal(decide(bash("ls -la /var/log && df -h"), pc(false)).action, "allow");
	assert.equal(decide(bash("sudo apt-get install -y mousepad"), pc(false)).action, "ask");
	assert.equal(decide(bash("apt install htop"), pc(false)).patternKey, "package install");
	assert.equal(decide(bash("sudo systemctl status nginx"), pc(false)).patternKey, "sudo");
	assert.equal(decide(bash("mkfs.ext4 /dev/sdb1"), pc(false)).patternKey, "mkfs");
	assert.equal(decide({ name: "write", arguments: { path: "/home/n/.ssh/authorized_keys", content: "x" } }, pc(false)).action, "ask");
});

test("trusted infrastructure bots run routine admin (sudo, installs, rm -rf) but still ask for destructive storage and power", () => {
	assert.equal(decide(bash("sudo apt-get install -y htop"), pc(true)).action, "allow");
	assert.equal(decide(bash("rm -rf ./build"), pc(true)).action, "allow");
	assert.equal(decide(bash("sudo zfs destroy tank/old"), pc(true)).patternKey, "zfs destroy");
	assert.equal(decide(bash("sudo reboot"), pc(true)).action, "ask");
});

test("deny rules win over yolo; answers match only their own pattern key; manual mode asks for side effects", () => {
	assert.equal(decide({ name: "forbidden", arguments: {} }, pc(false, "smart", { yolo: true })).action, "deny");
	assert.equal(decide(bash("mkfs /dev/sdz"), pc(false, "smart", { yolo: true })).action, "allow");
	assert.equal(decide(bash("rm -rf x"), pc(false, "smart", { botRules: ["rm -rf"] })).action, "allow");
	assert.equal(decide(bash("mkfs /dev/x # rm -rf"), pc(false, "smart", { botRules: ["rm -rf", "power"] })).patternKey, "mkfs");
	assert.equal(decide({ name: "write", arguments: { path: "notes.txt", content: "x" } }, pc(false, "manual")).action, "ask");
	assert.equal(decide({ name: "read", arguments: { path: "notes.txt" } }, pc(false, "manual")).action, "allow");
});

test("checking or repairing a disk asks even for trusted bots; reading disk information does not", () => {
	for (const trusted of [false, true]) {
		for (const cmd of ["diskutil verifyVolume /", "diskutil repairVolume /System/Volumes/Data", "diskutil apfs deleteVolume disk3s5", "fsck_apfs -n -l /dev/disk3s1", "sudo fsck -n /", "smartctl -t long /dev/sda", "btrfs scrub start /"]) {
			assert.equal(decide(bash(cmd), pc(trusted)).action, "ask", `${cmd} (trusted: ${trusted})`);
		}
		for (const cmd of ["diskutil list", "diskutil info /", "diskutil apfs list", "smartctl -a /dev/disk0", "df -h"]) {
			assert.equal(decide(bash(cmd), pc(trusted)).action, "allow", `${cmd} (trusted: ${trusted})`);
		}
	}
	assert.equal(decide(bash("diskutil verifyVolume /"), pc(true)).patternKey, "disk check");
});
