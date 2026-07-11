import { SkillIndexService } from "./indexing/skill-index.service";
import { SkillSearchDatabaseService } from "./indexing/skill-search-database.service";
import { PromptGuidanceService } from "./prompt/prompt-guidance.service";
import { SettingsLoaderService } from "./settings/settings-loader.service";
import { EnglishFuzzyMatcherService } from "./tokenization/english-fuzzy-matcher.service";
import { KoreanMorphologyAnalyzerService } from "./tokenization/korean-morphology-analyzer.service";
import { SearchTokenizerService } from "./tokenization/search-tokenizer.service";

const settingsLoader = new SettingsLoaderService();
const englishFuzzyMatcher = new EnglishFuzzyMatcherService();
const koreanMorphologyAnalyzer = new KoreanMorphologyAnalyzerService();
const searchTokenizer = new SearchTokenizerService(englishFuzzyMatcher, koreanMorphologyAnalyzer);
const promptGuidance = new PromptGuidanceService();
export const createSkillSearchDatabaseService = (): SkillSearchDatabaseService => new SkillSearchDatabaseService();

const skillSearchDatabase = createSkillSearchDatabaseService();
const skillIndex = new SkillIndexService(skillSearchDatabase, settingsLoader, searchTokenizer);

export const SERVICE = {
	settingsLoader,
	englishFuzzyMatcher,
	koreanMorphologyAnalyzer,
	searchTokenizer,
	promptGuidance,
	skillSearchDatabase,
	skillIndex,
} as const;
