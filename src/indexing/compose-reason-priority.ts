import type { ComposedSkillEntry } from "../shared";

/** compose relation 강도의 stable priority를 반환합니다. */
export const composeReasonPriority = (reason: ComposedSkillEntry["reason"]): number => {
	switch (reason) {
		case "seed":
			return 3;
		case "required":
			return 2;
		case "recommended":
			return 1;
		default:
			return 0;
	}
};
