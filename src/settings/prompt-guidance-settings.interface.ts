/**
 * prompt hook이 매 요청마다 사용할 정규화된 설정입니다.
 */
export interface PromptGuidanceSettings {
  /**
   * false일 때 두 prompt hook이 입력 payload를 그대로 통과시킵니다.
   */
  skillsPromptEnabled: boolean
  /**
   * `<skills>` marker를 제외한 custom guidance body입니다.
   */
  skillsPrompt?: string
  /**
   * built-in 또는 custom guidance에 표시할 prompt 전용 skill name 목록입니다.
   */
  promptSkillNames: string[]
}
