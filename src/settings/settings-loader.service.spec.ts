import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { SERVICE } from "../service-registry";
import { DEFAULT_SETTINGS } from "../shared";

type EnvSnapshot = NodeJS.ProcessEnv;

type SettingPayload = {
	roots?: string[];
	fileNames?: string[];
	presetSkills?: string[];
	cacheTtlMs?: number;
	maxTopK?: number;
	includePreviewBodyChars?: number;
	databasePath?: string;
};

/** settings loader service 동작 검증입니다. */
describe("settings loader service", () => {
	const loader = SERVICE.settingsLoader;
	let root = "";
	let previousCwd = process.cwd();
	let envSnapshot: EnvSnapshot = {};

	afterEach(() => {
		restoreEnvironment(envSnapshot);
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
			root = "";
		}
		process.chdir(previousCwd);
	});

	function restoreEnvironment(snapshot: EnvSnapshot): void {
		const keys = new Set([...Object.keys(process.env), ...Object.keys(snapshot)]);
		for (const key of keys) {
			const value = snapshot[key];
			if (typeof value === "undefined") {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}

	function setupProject(): void {
		previousCwd = process.cwd();
		root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-skill-registry-settings-"));
		envSnapshot = { ...process.env };
		process.chdir(root);
	}

	function writeProjectSetting(fileName: string, payload: SettingPayload): void {
		const filePath = path.join(root, fileName);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			JSON.stringify(
				{
					skillRegistry: payload,
				},
				null,
				2,
			),
			"utf-8",
		);
	}

	test("loads explicit databasePath in top-level settings", () => {
		setupProject();
		const absolutePath = path.join(root, "explicit", "custom.sqlite");
		writeProjectSetting(".pi/settings.json", {
			roots: ["./skills"],
			fileNames: ["SKILL.md"],
			presetSkills: ["alpha"],
			cacheTtlMs: 1234,
			maxTopK: 7,
			includePreviewBodyChars: 321,
			databasePath: absolutePath,
		});

		const settings = loader.loadSettings();

		expect(settings.roots).toEqual(["./skills"]);
		expect(settings.fileNames).toEqual(["SKILL.md"]);
		expect(settings.presetSkills).toEqual(["alpha"]);
		expect(settings.cacheTtlMs).toBe(1234);
		expect(settings.maxTopK).toBe(7);
		expect(settings.includePreviewBodyChars).toBe(321);
		expect(settings.databasePath).toBe(absolutePath);
	});

	test("prefers dedicated project settings over generic project block", () => {
		setupProject();
		writeProjectSetting(".pi/settings.json", {
			roots: ["./fallback"],
			fileNames: ["fallback.md"],
			presetSkills: ["fallback"],
			databasePath: path.join(root, "fallback.sqlite"),
		});
		writeProjectSetting(".pi/settings/skill-registry/skill-registry.json", {
			roots: ["./preferred"],
			fileNames: ["SKILL.md"],
			presetSkills: ["beta"],
		});

		const settings = loader.loadSettings();

		expect(settings.roots).toEqual(["./preferred"]);
		expect(settings.fileNames).toEqual(["SKILL.md"]);
		expect(settings.presetSkills).toEqual(["beta"]);
	});

	test("returns exact seven default roots when no settings supply roots", () => {
		setupProject();
		const ompAgentDir = path.join(root, "agents", "omp-dir");
		const ompAgentHome = path.join(root, "agents", "omp-home");
		const piAgentDir = path.join(root, "agents", "pi-agent");
		process.env.OMP_AGENT_DIR = ompAgentDir;
		process.env.OMP_AGENT_HOME = ompAgentHome;
		process.env.PI_CODING_AGENT_DIR = piAgentDir;
		fs.mkdirSync(ompAgentDir, { recursive: true });
		fs.mkdirSync(ompAgentHome, { recursive: true });
		fs.mkdirSync(piAgentDir, { recursive: true });

		const settings = loader.loadSettings();

		expect(settings.roots).toEqual(DEFAULT_SETTINGS.roots);
		expect(settings.roots.every((rootValue) => !rootValue.includes(".arcana-local"))).toBe(true);
	});

	test("resolves relative configured databasePath against project root", () => {
		setupProject();
		writeProjectSetting(".pi/settings/skill-registry/skill-registry.json", {
			roots: ["./skills"],
			fileNames: ["SKILL.md"],
			databasePath: "relative-cache/index.sqlite",
		});

		const settings = loader.loadSettings();

		expect(settings.databasePath).toBe(path.join(root, "relative-cache", "index.sqlite"));
	});

	test("expands databasePath home shorthand", () => {
		setupProject();
		writeProjectSetting(".pi/settings/skill-registry/skill-registry.json", {
			roots: ["./skills"],
			fileNames: ["SKILL.md"],
			databasePath: "~/agent-cache/skill-registry.sqlite",
		});

		const settings = loader.loadSettings();

		expect(settings.databasePath).toBe(path.join(os.homedir(), "agent-cache/skill-registry.sqlite"));
	});

	test("uses OMP_AGENT_DIR before OMP_AGENT_HOME and PI_CODING_AGENT_DIR for default databasePath", () => {
		setupProject();
		envSnapshot = { ...process.env };
		const ompAgentDir = path.join(root, "omp-dir");
		const ompAgentHome = path.join(root, "omp-home");
		const piAgentDir = path.join(root, "pi-agent");
		process.env.OMP_AGENT_DIR = ompAgentDir;
		process.env.OMP_AGENT_HOME = ompAgentHome;
		process.env.PI_CODING_AGENT_DIR = piAgentDir;

		const settings = loader.loadSettings();

		expect(settings.databasePath).toBe(path.join(ompAgentDir, "cache", "skill-registry", "index.sqlite"));
		restoreEnvironment(envSnapshot);
	});

	test("falls back to OMP_AGENT_HOME when OMP_AGENT_DIR is unset", () => {
		setupProject();
		process.env.OMP_AGENT_DIR = "";
		process.env.OMP_AGENT_HOME = path.join(root, "omp-home");
		process.env.PI_CODING_AGENT_DIR = "";

		const settings = loader.loadSettings();

		expect(settings.databasePath).toBe(path.join(root, "omp-home", "cache", "skill-registry", "index.sqlite"));
	});

	test("falls back to PI_CODING_AGENT_DIR when OMP_AGENT_DIR and OMP_AGENT_HOME are unset", () => {
		setupProject();
		process.env.OMP_AGENT_DIR = "";
		process.env.OMP_AGENT_HOME = "";
		process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");

		const settings = loader.loadSettings();

		expect(settings.databasePath).toBe(path.join(root, "pi-agent", "cache", "skill-registry", "index.sqlite"));
	});

	test("falls back to ~/.omp/agent when no agent env vars are set", () => {
		setupProject();
		process.env.OMP_AGENT_DIR = "";
		process.env.OMP_AGENT_HOME = "";
		process.env.PI_CODING_AGENT_DIR = "";

		const settings = loader.loadSettings();

		expect(settings.databasePath).toBe(path.join(os.homedir(), ".omp", "agent", "cache", "skill-registry", "index.sqlite"));
	});
});
