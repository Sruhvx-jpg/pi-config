/**
 * ask_user_question Extension for Pi
 *
 * Interactive question tool allowing the assistant to ask the user clarifying
 * questions, present options, or gather open-ended input before making assumptions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface OptionItem {
	label: string;
	description?: string;
	value?: string;
}

interface DisplayOption extends OptionItem {
	isOther?: boolean;
}

interface QuestionDef {
	id: string;
	label: string;
	prompt: string;
	options: OptionItem[];
	allowCustom: boolean;
}

interface AnswerResult {
	id: string;
	label: string;
	value: string;
	wasCustom: boolean;
	index?: number;
}

interface AskQuestionDetails {
	mode: "single" | "multi";
	question?: string;
	options?: string[];
	answer?: string | null;
	wasCustom?: boolean;
	questions?: QuestionDef[];
	answers?: AnswerResult[];
	cancelled: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description explaining the option" })),
	value: Type.Optional(Type.String({ description: "Optional value returned if selected" })),
});

const QuestionItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Unique identifier for this question" })),
	question: Type.Optional(Type.String({ description: "The question prompt" })),
	prompt: Type.Optional(Type.String({ description: "Alternative name for the question prompt" })),
	label: Type.Optional(Type.String({ description: "Short tab label (e.g. 'DB', 'Scope')" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options to choose from (omit for direct open-ended text input)" })),
	allow_custom: Type.Optional(Type.Boolean({ description: "Allow user to type a custom answer (default: true)" })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.Optional(Type.String({ description: "The question to ask the user (for single question mode)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options to choose from. Omit if asking an open-ended question." })),
	allow_custom: Type.Optional(Type.Boolean({ description: "Whether to allow custom text input in addition to options (default: true)" })),
	questions: Type.Optional(Type.Array(QuestionItemSchema, { description: "Array of questions for multi-question questionnaire" })),
});

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user an interactive question with optional multiple-choice options or open-ended input. Always use this when you need clarification, user decisions, or preferences before proceeding with assumptions.",
		promptSnippet: "Ask the user a question before proceeding with assumptions",
		promptGuidelines: [
			"Use ask_user_question whenever you are unsure about user preferences, architectural choices, destructive operations, or missing requirements rather than making assumptions.",
			"Provide concrete multiple-choice options with clear descriptions when feasible, and allow the user to type custom input if needed.",
		],
		parameters: AskUserQuestionParams,
		executionMode: "sequential",

		prepareArguments(rawArgs: unknown) {
			if (!rawArgs || typeof rawArgs !== "object") return rawArgs;
			const args: Record<string, unknown> = rawArgs as Record<string, unknown>;

			function normalizeOption(opt: unknown): { label: string; description?: string; value?: string } {
				if (typeof opt === "string") {
					return { label: opt, value: opt };
				}
				if (opt && typeof opt === "object") {
					const o: Record<string, unknown> = opt as Record<string, unknown>;
					const label: string =
						typeof o.label === "string" ? o.label : typeof o.value === "string" ? o.value : String(opt);
					const description: string | undefined = typeof o.description === "string" ? o.description : undefined;
					const value: string = typeof o.value === "string" ? o.value : label;
					return { label, description, value };
				}
				return { label: String(opt), value: String(opt) };
			}

			function normalizeQuestionItem(q: unknown, index: number): QuestionDef {
				if (!q || typeof q !== "object") {
					const text = String(q);
					return {
						id: `q${index + 1}`,
						label: `Q${index + 1}`,
						prompt: text,
						options: [],
						allowCustom: true,
					};
				}
				const obj: Record<string, unknown> = q as Record<string, unknown>;
				const prompt: string =
					typeof obj.question === "string"
						? obj.question
						: typeof obj.prompt === "string"
							? obj.prompt
							: typeof obj.text === "string"
								? obj.text
								: `Question ${index + 1}`;
				const label: string = typeof obj.label === "string" ? obj.label : `Q${index + 1}`;
				const id: string = typeof obj.id === "string" ? obj.id : `q${index + 1}`;
				const allowCustom: boolean =
					typeof obj.allow_custom === "boolean"
						? obj.allow_custom
						: typeof obj.allowCustom === "boolean"
							? obj.allowCustom
							: true;
				const rawOpts: unknown = obj.options;
				const options: OptionItem[] = Array.isArray(rawOpts) ? rawOpts.map(normalizeOption) : [];
				return { id, label, prompt, options, allowCustom };
			}

			const question: string | undefined =
				typeof args.question === "string"
					? args.question
					: typeof args.prompt === "string"
						? args.prompt
						: typeof args.query === "string"
							? args.query
							: typeof args.message === "string"
								? args.message
								: undefined;

			let options: OptionItem[] | undefined = undefined;
			if (Array.isArray(args.options)) {
				options = args.options.map(normalizeOption);
			}

			let questions: QuestionDef[] | undefined = undefined;
			if (Array.isArray(args.questions)) {
				questions = args.questions.map(normalizeQuestionItem);
			}

			const allow_custom: boolean =
				typeof args.allow_custom === "boolean"
					? args.allow_custom
					: typeof args.allowCustom === "boolean"
						? args.allowCustom
						: true;

			return {
				question,
				options,
				allow_custom,
				questions,
			};
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Determine if multi-question or single-question
			const rawQuestions: QuestionItemSchemaType[] | undefined = params.questions;
			const isMulti: boolean = Array.isArray(rawQuestions) && rawQuestions.length > 1;

			if (isMulti && rawQuestions) {
				const questionDefs: QuestionDef[] = rawQuestions.map((q, idx) => ({
					id: q.id || `q${idx + 1}`,
					label: q.label || `Q${idx + 1}`,
					prompt: q.question || q.prompt || `Question ${idx + 1}`,
					options: (q.options || []).map((o) => ({
						label: o.label,
						description: o.description,
						value: o.value || o.label,
					})),
					allowCustom: q.allow_custom !== false,
				}));

				return await executeMultiQuestion(ctx, questionDefs);
			}

			// Single question mode
			let singlePrompt: string = params.question || "";
			let singleOptions: OptionItem[] = (params.options || []).map((o) => ({
				label: o.label,
				description: o.description,
				value: o.value || o.label,
			}));
			let allowCustom: boolean = params.allow_custom !== false;

			if (!singlePrompt && Array.isArray(rawQuestions) && rawQuestions.length === 1) {
				const q: QuestionItemSchemaType = rawQuestions[0];
				singlePrompt = q.question || q.prompt || "";
				if (q.options) {
					singleOptions = q.options.map((o) => ({
						label: o.label,
						description: o.description,
						value: o.value || o.label,
					}));
				}
				if (typeof q.allow_custom === "boolean") {
					allowCustom = q.allow_custom;
				}
			}

			if (!singlePrompt) {
				singlePrompt = "Please provide your input:";
			}

			return await executeSingleQuestion(ctx, singlePrompt, singleOptions, allowCustom);
		},

		renderCall(args, theme) {
			const rawQuestions = args.questions as Array<{ label?: string; question?: string; prompt?: string }> | undefined;
			if (Array.isArray(rawQuestions) && rawQuestions.length > 1) {
				let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) +
					theme.fg("muted", `${rawQuestions.length} questions`);
				const labels = rawQuestions.map((q, i) => q.label || `Q${i + 1}`).join(", ");
				text += `\n${theme.fg("dim", `  Topics: ${labels}`)}`;
				return new Text(text, 0, 0);
			}

			const prompt = args.question || args.prompt || "Question";
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", String(prompt));
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length > 0) {
				const labels = opts.map((o: { label?: string }) => o.label || String(o));
				text += `\n${theme.fg("dim", `  Options: ${labels.join(" | ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskQuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled by user"), 0, 0);
			}

			if (details.mode === "multi" && details.answers) {
				const lines = details.answers.map((a) => {
					const prefix = a.wasCustom ? "(wrote) " : "";
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", prefix)}${theme.fg("text", a.label)}`;
				});
				return new Text(lines.join("\n"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "(wrote) ") +
						theme.fg("accent", details.answer || ""),
					0,
					0,
				);
			}

			return new Text(
				theme.fg("success", "✓ ") + theme.fg("accent", details.answer || ""),
				0,
				0,
			);
		},
	});
}

type QuestionItemSchemaType = {
	id?: string;
	question?: string;
	prompt?: string;
	label?: string;
	options?: Array<{ label: string; description?: string; value?: string }>;
	allow_custom?: boolean;
};

async function executeSingleQuestion(
	ctx: ExtensionContext,
	questionPrompt: string,
	options: OptionItem[],
	allowCustom: boolean,
) {
	const hasOptions = options.length > 0;
	const optionLabels = options.map((o) => o.label);

	// Fallback for non-interactive / non-TUI modes
	if (ctx.mode !== "tui") {
		if (hasOptions) {
			const selectOptions = allowCustom ? [...optionLabels, "Type something else..."] : optionLabels;
			const answer = await ctx.ui.select(questionPrompt, selectOptions);
			if (answer === undefined) {
				return {
					content: [{ type: "text", text: "User cancelled the question prompt" }],
					details: {
						mode: "single",
						question: questionPrompt,
						options: optionLabels,
						answer: null,
						cancelled: true,
					} as AskQuestionDetails,
				};
			}
			if (answer === "Type something else...") {
				const customAnswer = await ctx.ui.input("Enter your response:");
				if (customAnswer === undefined || customAnswer.trim() === "") {
					return {
						content: [{ type: "text", text: "User cancelled the question prompt" }],
						details: {
							mode: "single",
							question: questionPrompt,
							options: optionLabels,
							answer: null,
							cancelled: true,
						} as AskQuestionDetails,
					};
				}
				return {
					content: [{ type: "text", text: `User wrote: ${customAnswer.trim()}` }],
					details: {
						mode: "single",
						question: questionPrompt,
						options: optionLabels,
						answer: customAnswer.trim(),
						wasCustom: true,
						cancelled: false,
					} as AskQuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${answer}` }],
				details: {
					mode: "single",
					question: questionPrompt,
					options: optionLabels,
					answer,
					wasCustom: false,
					cancelled: false,
				} as AskQuestionDetails,
			};
		} else {
			const answer = await ctx.ui.input(questionPrompt);
			if (answer === undefined || answer.trim() === "") {
				return {
					content: [{ type: "text", text: "User cancelled the question prompt" }],
					details: {
						mode: "single",
						question: questionPrompt,
						options: [],
						answer: null,
						cancelled: true,
					} as AskQuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User wrote: ${answer.trim()}` }],
				details: {
					mode: "single",
					question: questionPrompt,
					options: [],
					answer: answer.trim(),
					wasCustom: true,
					cancelled: false,
				} as AskQuestionDetails,
			};
		}
	}

	// Interactive TUI Component
	const displayOptions: DisplayOption[] = [...options];
	if (hasOptions && allowCustom) {
		displayOptions.push({ label: "Type something...", isOther: true });
	}

	const result = await ctx.ui.custom<{ answer: string; value: string; wasCustom: boolean; index?: number } | null>(
		(tui, theme, _kb, done) => {
			let optionIndex = 0;
			let editMode = !hasOptions; // Start in edit mode immediately if no options
			let cachedLines: string[] | undefined;

			const editorTheme: EditorTheme = {
				borderColor: (s) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);

			editor.onSubmit = (value: string) => {
				const trimmed = value.trim();
				if (trimmed) {
					done({ answer: trimmed, value: trimmed, wasCustom: true });
				} else if (hasOptions) {
					editMode = false;
					editor.setText("");
					refresh();
				} else {
					done(null);
				}
			};

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function handleInput(data: string) {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						if (hasOptions) {
							editMode = false;
							editor.setText("");
							refresh();
						} else {
							done(null);
						}
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				// Direct 1-9 number keys selection
				if (/^[1-9]$/.test(data)) {
					const num = parseInt(data, 10) - 1;
					if (num >= 0 && num < displayOptions.length) {
						const selected = displayOptions[num];
						if (selected.isOther) {
							optionIndex = num;
							editMode = true;
							refresh();
						} else {
							done({
								answer: selected.label,
								value: selected.value || selected.label,
								wasCustom: false,
								index: num + 1,
							});
						}
						return;
					}
				}

				if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
					optionIndex = Math.min(displayOptions.length - 1, optionIndex + 1);
					refresh();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const selected = displayOptions[optionIndex];
					if (selected.isOther) {
						editMode = true;
						refresh();
					} else {
						done({
							answer: selected.label,
							value: selected.value || selected.label,
							wasCustom: false,
							index: optionIndex + 1,
						});
					}
					return;
				}

				if (matchesKey(data, Key.escape)) {
					done(null);
				}
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const lines: string[] = [];
				const renderWidth = Math.max(1, width);

				function addWrapped(text: string) {
					lines.push(...wrapTextWithAnsi(text, renderWidth));
				}

				function addWrappedWithPrefix(prefix: string, text: string) {
					const prefixWidth = visibleWidth(prefix);
					if (prefixWidth >= renderWidth) {
						addWrapped(prefix + text);
						return;
					}
					const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
					const continuationPrefix = " ".repeat(prefixWidth);
					for (let i = 0; i < wrapped.length; i++) {
						lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
					}
				}

				lines.push(theme.fg("accent", "─".repeat(renderWidth)));
				addWrappedWithPrefix(" ", theme.fg("text", theme.bold(questionPrompt)));
				lines.push("");

				if (hasOptions) {
					for (let i = 0; i < displayOptions.length; i++) {
						const opt = displayOptions[i];
						const isSelected = i === optionIndex;
						const isOther = opt.isOther === true;
						const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
						const label = `${i + 1}. ${opt.label}${isOther && editMode ? " ✎" : ""}`;
						const color = isSelected || (isOther && editMode) ? "accent" : "text";

						addWrappedWithPrefix(prefix, theme.fg(color, label));

						if (opt.description) {
							addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
						}
					}
				}

				if (editMode) {
					lines.push("");
					addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
					for (const line of editor.render(Math.max(1, renderWidth - 2))) {
						lines.push(` ${line}`);
					}
				}

				lines.push("");
				if (editMode) {
					addWrappedWithPrefix(
						" ",
						theme.fg("dim", hasOptions ? "Enter to submit • Esc to return to options" : "Enter to submit • Esc to cancel"),
					);
				} else {
					addWrappedWithPrefix(" ", theme.fg("dim", "↑↓/1-9 navigate & select • Enter confirm • Esc cancel"));
				}
				lines.push(theme.fg("accent", "─".repeat(renderWidth)));

				cachedLines = lines;
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
				},
				handleInput,
			};
		},
	);

	if (!result) {
		return {
			content: [{ type: "text", text: "User cancelled the question prompt" }],
			details: {
				mode: "single",
				question: questionPrompt,
				options: optionLabels,
				answer: null,
				cancelled: true,
			} as AskQuestionDetails,
		};
	}

	if (result.wasCustom) {
		return {
			content: [{ type: "text", text: `User wrote: ${result.answer}` }],
			details: {
				mode: "single",
				question: questionPrompt,
				options: optionLabels,
				answer: result.answer,
				wasCustom: true,
				cancelled: false,
			} as AskQuestionDetails,
		};
	}

	return {
		content: [{ type: "text", text: `User selected: ${result.index ? `${result.index}. ` : ""}${result.answer}` }],
		details: {
			mode: "single",
			question: questionPrompt,
			options: optionLabels,
			answer: result.answer,
			wasCustom: false,
			cancelled: false,
		} as AskQuestionDetails,
	};
}

async function executeMultiQuestion(ctx: ExtensionContext, questions: QuestionDef[]) {
	// Fallback for non-interactive / non-TUI modes
	if (ctx.mode !== "tui") {
		const answers: AnswerResult[] = [];
		for (const q of questions) {
			const hasOpts = q.options.length > 0;
			const optLabels = q.options.map((o) => o.label);
			if (hasOpts) {
				const selectOptions = q.allowCustom ? [...optLabels, "Type something..."] : optLabels;
				const res = await ctx.ui.select(q.prompt, selectOptions);
				if (res === undefined) {
					return {
						content: [{ type: "text", text: "User cancelled questionnaire" }],
						details: {
							mode: "multi",
							questions,
							answers,
							cancelled: true,
						} as AskQuestionDetails,
					};
				}
				if (res === "Type something...") {
					const customRes = await ctx.ui.input(`Your answer for "${q.label}":`);
					const val = customRes?.trim() || "(empty)";
					answers.push({ id: q.id, label: val, value: val, wasCustom: true });
				} else {
					answers.push({ id: q.id, label: res, value: res, wasCustom: false });
				}
			} else {
				const res = await ctx.ui.input(q.prompt);
				const val = res?.trim() || "(empty)";
				answers.push({ id: q.id, label: val, value: val, wasCustom: true });
			}
		}

		const resultLines = answers.map((a) => {
			const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
			return `${qLabel}: ${a.wasCustom ? `user wrote: ${a.label}` : `user selected: ${a.label}`}`;
		});

		return {
			content: [{ type: "text", text: resultLines.join("\n") }],
			details: {
				mode: "multi",
				questions,
				answers,
				cancelled: false,
			} as AskQuestionDetails,
		};
	}

	const totalTabs = questions.length + 1; // questions + Submit tab

	const result = await ctx.ui.custom<{ answers: AnswerResult[]; cancelled: boolean }>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answersMap = new Map<string, AnswerResult>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			done({ answers: Array.from(answersMap.values()), cancelled });
		}

		function currentQuestion(): QuestionDef | undefined {
			return questions[currentTab];
		}

		function currentOptions(): DisplayOption[] {
			const q = currentQuestion();
			if (!q) return [];
			const opts: DisplayOption[] = [...q.options];
			if (q.allowCustom) {
				opts.push({ label: "Type something...", isOther: true });
			}
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answersMap.has(q.id));
		}

		function advanceAfterAnswer() {
			if (currentTab < questions.length - 1) {
				currentTab++;
			} else {
				currentTab = questions.length; // Jump to Submit tab
			}
			optionIndex = 0;
			refresh();
		}

		function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
			answersMap.set(questionId, { id: questionId, value, label, wasCustom, index });
		}

		editor.onSubmit = (value: string) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim() || "(empty)";
			saveAnswer(inputQuestionId, trimmed, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = currentOptions();

			// Tab switching
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				currentTab = (currentTab + 1) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}

			// Submit tab actions
			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					submit(false);
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			// Direct number select
			if (/^[1-9]$/.test(data) && q) {
				const num = parseInt(data, 10) - 1;
				if (num >= 0 && num < opts.length) {
					const opt = opts[num];
					if (opt.isOther) {
						inputMode = true;
						inputQuestionId = q.id;
						editor.setText("");
						refresh();
						return;
					}
					saveAnswer(q.id, opt.value || opt.label, opt.label, false, num + 1);
					advanceAfterAnswer();
					return;
				}
			}

			if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				if (opts.length === 0) {
					// Free text input for this question
					inputMode = true;
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
					return;
				}
				const opt = opts[optionIndex];
				if (opt.isOther) {
					inputMode = true;
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(q.id, opt.value || opt.label, opt.label, false, optionIndex + 1);
				advanceAfterAnswer();
				return;
			}

			if (matchesKey(data, Key.escape)) {
				submit(true);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const renderWidth = Math.max(1, width);
			const q = currentQuestion();
			const opts = currentOptions();

			function addWrapped(text: string) {
				lines.push(...wrapTextWithAnsi(text, renderWidth));
			}

			function addWrappedWithPrefix(prefix: string, text: string) {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					addWrapped(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			// Tab bar
			const tabs: string[] = ["← "];
			for (let i = 0; i < questions.length; i++) {
				const isActive = i === currentTab;
				const isAnswered = answersMap.has(questions[i].id);
				const lbl = questions[i].label;
				const box = isAnswered ? "■" : "□";
				const color = isAnswered ? "success" : "muted";
				const text = ` ${box} ${lbl} `;
				const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
				tabs.push(`${styled} `);
			}
			const canSubmit = allAnswered();
			const isSubmitTab = currentTab === questions.length;
			const submitText = " ✓ Submit ";
			const submitStyled = isSubmitTab
				? theme.bg("selectedBg", theme.fg("text", submitText))
				: theme.fg(canSubmit ? "success" : "dim", submitText);
			tabs.push(`${submitStyled} →`);
			addWrappedWithPrefix(" ", tabs.join(""));
			lines.push("");

			function renderOptions() {
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const isOther = opt.isOther === true;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
					const color = selected || (isOther && inputMode) ? "accent" : "text";

					addWrappedWithPrefix(prefix, theme.fg(color, label));
					if (opt.description) {
						addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
					}
				}
			}

			if (inputMode && q) {
				addWrappedWithPrefix(" ", theme.fg("text", theme.bold(q.prompt)));
				lines.push("");
				renderOptions();
				lines.push("");
				addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
				for (const line of editor.render(Math.max(1, renderWidth - 2))) {
					lines.push(` ${line}`);
				}
				lines.push("");
				addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Summary & Submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answersMap.get(question.id);
					if (answer) {
						const prefix = answer.wasCustom ? "(wrote) " : "";
						const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
						addWrappedWithPrefix(" ", summary);
					}
				}
				lines.push("");
				if (allAnswered()) {
					addWrappedWithPrefix(" ", theme.fg("success", "All answered! Press Enter to submit."));
				} else {
					const missing = questions
						.filter((item) => !answersMap.has(item.id))
						.map((item) => item.label)
						.join(", ");
					addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
				}
			} else if (q) {
				addWrappedWithPrefix(" ", theme.fg("text", theme.bold(q.prompt)));
				lines.push("");
				renderOptions();
			}

			lines.push("");
			if (!inputMode) {
				const help = "Tab/←→ switch tabs • ↑↓/1-9 select • Enter confirm • Esc cancel";
				addWrappedWithPrefix(" ", theme.fg("dim", help));
			}
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	if (result.cancelled) {
		return {
			content: [{ type: "text", text: "User cancelled the questionnaire" }],
			details: {
				mode: "multi",
				questions,
				answers: result.answers,
				cancelled: true,
			} as AskQuestionDetails,
		};
	}

	const answerLines = result.answers.map((a) => {
		const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
		if (a.wasCustom) {
			return `${qLabel}: user wrote: ${a.label}`;
		}
		return `${qLabel}: user selected: ${a.index ? `${a.index}. ` : ""}${a.label}`;
	});

	return {
		content: [{ type: "text", text: answerLines.join("\n") }],
		details: {
			mode: "multi",
			questions,
			answers: result.answers,
			cancelled: false,
		} as AskQuestionDetails,
	};
}
