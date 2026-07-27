import { type Static, Type } from "@sinclair/typebox";

/**
 * Runtime slash command에서 전달되는 원문 인자를 보존하는 요청 계약입니다.
 */
export const RegistryCommandRequestSchema = Type.Object({
	/** Runtime이 command name 뒤에서 분리한 원문 인자입니다. */
	args: Type.String(),
});

/**
 * Runtime adapter가 사용자 알림으로 투영할 공통 실행 결과 계약입니다.
 */
export const RegistryCommandResultSchema = Type.Object({
	/** 실행된 command를 runtime adapter가 식별하는 discriminant입니다. */
	kind: Type.Union([Type.Literal("reindex"), Type.Literal("discover"), Type.Literal("diagnostics")]),
	/** 사용자에게 표시할 command 실행 상태입니다. */
	status: Type.Union([Type.Literal("success"), Type.Literal("error")]),
	/** 기존 domain 결과를 compact text로 직렬화한 메시지입니다. */
	message: Type.String({ minLength: 1 }),
	/** 기존 domain owner가 생성한 structured 결과를 보존합니다. */
	details: Type.Optional(Type.Unknown()),
});

/** 공통 command 요청 타입입니다. */
export type RegistryCommandRequest = Static<typeof RegistryCommandRequestSchema>;

/** 공통 command 결과 타입입니다. */
export type RegistryCommandResult = Static<typeof RegistryCommandResultSchema>;
