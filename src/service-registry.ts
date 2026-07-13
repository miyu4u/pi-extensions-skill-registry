import { SkillDocumentParser } from "./indexing/skill-document-parser";
import { SkillFileScanner } from "./indexing/skill-file-scanner";
import { SkillIndexService } from "./indexing/skill-index.service";
import { SkillInputNormalizer } from "./indexing/skill-input-normalizer";
import { SkillIndexLoader } from "./indexing/skill-index-loader";
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
const skillInputNormalizer = new SkillInputNormalizer(settingsLoader);
const skillFileScanner = new SkillFileScanner();
const skillDocumentParser = new SkillDocumentParser();
const activeIndexStore = new ActiveIndexStore();
const skillIndexLoader = new SkillIndexLoader(
	skillSearchDatabase,
	searchTokenizer,
	skillFileScanner,
	skillDocumentParser,
	activeIndexStore,
);
const skillIndex = new SkillIndexService(skillSearchDatabase, searchTokenizer, activeIndexStore);

export const SERVICE = {
	settingsLoader,
	englishFuzzyMatcher,
	koreanMorphologyAnalyzer,
	searchTokenizer,
	promptGuidance,
	skillSearchDatabase,
	skillInputNormalizer,
	skillFileScanner,
	skillDocumentParser,
	skillIndexLoader,
	skillIndex,
} as const;
import { ActiveIndexStore } from "./indexing/active-index-store";
