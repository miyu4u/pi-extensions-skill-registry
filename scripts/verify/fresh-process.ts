import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyDiagnostics, formatDiagnostics, type VerificationDiagnostics, VerificationFailure } from "./diagnostics";

/** fresh-process child에 전달하는 JSON payload입니다. */
export type FreshProcessRequest = {
	bundlePath: string;
	roots: string[];
	agentDir: string;
	workspaceRoot?: string;
	databasePath: string;
	requireExactKnownResolve?: boolean;
};

/** fresh-process child가 stdout으로 내보내는 JSON 결과입니다. */
export type FreshProcessResponse = {
	ok: boolean;
	diagnostics: VerificationDiagnostics;
	error?: string;
};

const CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fresh-process-child.ts");

/**
 * 별도 Bun child process에서 bundle을 import해 planning contract를 실행합니다.
 * parent process의 module cache와 active index를 공유하지 않습니다.
 */
export async function runFreshProcessContract(input: {
	bundlePath: string;
	roots: string[];
	requireExactKnownResolve?: boolean;
	workspaceRoot?: string;
}): Promise<FreshProcessResponse> {
	const workspaceRoot = input.workspaceRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-fresh-"));
	const agentDir = path.join(workspaceRoot, "agent");
	const databasePath = path.join(agentDir, "cache", "skill-registry", "index.sqlite");
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });

	const request: FreshProcessRequest = {
		bundlePath: path.resolve(input.bundlePath),
		roots: input.roots.map((root) => path.resolve(root)),
		agentDir,
		workspaceRoot,
		databasePath,
		requireExactKnownResolve: input.requireExactKnownResolve,
	};

	const response = await spawnFreshChild(request);
	if (!response.ok) {
		const diagnostics = response.diagnostics ?? createEmptyDiagnostics({ freshProcess: false });
		diagnostics.freshProcess = false;
		diagnostics.errors.push(response.error ?? "fresh-process contract failed");
		throw new VerificationFailure(response.error ?? "fresh-process contract failed", diagnostics);
	}

	response.diagnostics.freshProcess = true;
	return response;
}

/**
 * stale fixture bundle에서 실패하고 최신 bundle에서 성공하는지 확인합니다.
 */
export async function assertStaleFailsAndRebuiltSucceeds(input: {
	staleBundlePath: string;
	rebuiltBundlePath: string;
	roots: string[];
}): Promise<void> {
	let staleFailed = false;
	try {
		await runFreshProcessContract({
			bundlePath: input.staleBundlePath,
			roots: input.roots,
			requireExactKnownResolve: true,
		});
	} catch (error) {
		staleFailed = true;
		if (!(error instanceof VerificationFailure)) {
			throw error;
		}
	}
	if (!staleFailed) {
		throw new Error("expected stale bundle fresh-process contract to fail");
	}

	const rebuilt = await runFreshProcessContract({
		bundlePath: input.rebuiltBundlePath,
		roots: input.roots,
		requireExactKnownResolve: true,
	});
	if (!rebuilt.ok || rebuilt.diagnostics.freshProcess !== true) {
		throw new VerificationFailure(
			`rebuilt bundle fresh-process failed\n${formatDiagnostics(rebuilt.diagnostics)}`,
			rebuilt.diagnostics,
		);
	}
}

async function spawnFreshChild(request: FreshProcessRequest): Promise<FreshProcessResponse> {
	return await new Promise<FreshProcessResponse>((resolve, reject) => {
		const child = spawn("bun", [CHILD_SCRIPT], {
			cwd: request.workspaceRoot,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				OMP_AGENT_DIR: request.agentDir,
				OMP_AGENT_HOME: "",
				PI_CODING_AGENT_DIR: "",
			},
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const trimmed = stdout.trim();
			if (!trimmed) {
				reject(new Error(`fresh-process child produced no stdout (code=${code}): ${stderr}`));
				return;
			}
			try {
				const parsed = JSON.parse(trimmed) as FreshProcessResponse;
				resolve(parsed);
			} catch (error) {
				reject(
					new Error(
						`fresh-process child returned invalid JSON (code=${code}): ${trimmed}\nstderr=${stderr}\nparseError=${String(error)}`,
					),
				);
			}
		});

		child.stdin.write(JSON.stringify(request));
		child.stdin.end();
	});
}
