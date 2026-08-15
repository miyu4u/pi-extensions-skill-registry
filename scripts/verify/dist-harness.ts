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

/** built registration에서 캡처한 before_agent_start handler의 입력과 결과입니다. */
export type CapturedBeforeAgentStartHandler = (event: {
	systemPrompt?: string | readonly string[];
}) => Promise<{ systemPrompt: string } | undefined>;

/** built registration에서 캡처한 before_provider_request handler의 입력과 결과입니다. */
export type CapturedBeforeProviderRequestHandler = (event: { payload: unknown }) => unknown | Promise<unknown> | undefined;

/** dist entrypoint가 등록한 skill_registry handler 묶음입니다. */
export type DistHarness = {
	execute: CapturedSkillRegistryExecute;
	bundlePath: string;
	commandNames: string[];
	beforeAgentStart: CapturedBeforeAgentStartHandler;
	beforeProviderRequest: CapturedBeforeProviderRequestHandler;
};

/**
 * built bundle을 import하고 fake ExtensionAPI에 register한 뒤
 * tool, command, prompt hook handler를 캡처합니다.
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
	let beforeAgentStart: CapturedBeforeAgentStartHandler | undefined;
	let beforeProviderRequest: CapturedBeforeProviderRequestHandler | undefined;
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
		/**
		 * host lifecycle event handler를 이름별로 보관해 built registration을 직접 실행할 수 있게 합니다.
		 *
		 * @param eventName host가 dispatch하는 lifecycle event 이름입니다.
		 * @param handler extension이 등록한 lifecycle callback입니다.
		 */
		on(eventName: string, handler: unknown) {
			if (eventName === "before_agent_start") {
				beforeAgentStart = handler as CapturedBeforeAgentStartHandler;
				return;
			}

			if (eventName === "before_provider_request") {
				beforeProviderRequest = handler as CapturedBeforeProviderRequestHandler;
			}
		},
	} as unknown as ExtensionAPI;

	register(pi);
	if (!execute) {
		throw new Error(`dist harness: skill_registry.execute was not registered from ${absoluteBundlePath}`);
	}
	if (!beforeAgentStart || !beforeProviderRequest) {
		throw new Error(`dist harness: prompt hook handlers were not registered from ${absoluteBundlePath}`);
	}

	return {
		execute,
		bundlePath: absoluteBundlePath,
		commandNames,
		beforeAgentStart,
		beforeProviderRequest,
	};
}
