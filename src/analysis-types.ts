export type AnalysisMode = 'full' | 'degraded' | 'describe-only';

export type AnalysisDiagnostic = {
	code: string;
	message: string;
};

export type AnalysisInfo = {
	mode: AnalysisMode;
	diagnostics: AnalysisDiagnostic[];
};
