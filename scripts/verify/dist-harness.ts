import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** skill_registry tool 실행 결과의 structured payload입니다. */
export type CapturedToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
};

/** fake ExtensionAPI에 등록된 skill_registry execute handler입니다. */
export type CapturedSkillRegistryExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onUpdate?: ((partial: CapturedToolResult) => void) | undefined,
	ctx?: unknown,
) => Promise<CapturedToolResult>;

/** dist entrypoint가 등록한 skill_registry handler 묶음입니다. */
export type DistHarness = {
	execute: CapturedSkillRegistryExecute;
	bundlePath: string;
	commandNames: string[];
};

/**
 * built bundle을 import하고 fake ExtensionAPI에 register한 뒤
 * skill_registry.execute handler만 캡처합니다.
 */
export async function loadDistHarness(bundlePath: string): Promise<DistHarness> {
	const absoluteBundlePath = path.resolve(bundlePath);
	const moduleUrl = `${pathToFileURL(absoluteBundlePath).href}?t=${Date.now()}`;
	const imported = await import(moduleUrl);
	const register = (imported.default ?? imported) as (pi: ExtensionAPI) => void;
	if (typeof register !== "function") {
		throw new Error(`dist harness: default export register function missing at ${absoluteBundlePath}`);
	}

	let execute: CapturedSkillRegistryExecute | undefined;
	const commandNames: string[] = [];
	const pi = {
		registerTool(tool: unknown) {
			const registered = tool as { name?: string; execute?: CapturedSkillRegistryExecute };
			if (registered.name === "skill_registry" && typeof registered.execute === "function") {
				execute = registered.execute;
			}
		},
		registerCommand(name: string) {
			commandNames.push(name);
		},
		on() {},
	} as unknown as ExtensionAPI;

	register(pi);
	if (!execute) {
		throw new Error(`dist harness: skill_registry.execute was not registered from ${absoluteBundlePath}`);
	}

	return {
		execute,
		bundlePath: absoluteBundlePath,
		commandNames,
	};
}
