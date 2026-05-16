/*
ABOUTME: Runs Ruby code from the editor and rendered markdown using ruby.wasm runtimes.
ABOUTME: Adds version-aware runtime loading, block execution, and inline REPL-style output.
*/
import {
	App,
	Editor,
	EditorPosition,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
} from "obsidian";
import { RubyVM, consolePrinter } from "@ruby/wasm-wasi";

const RUBY_WASM_PACKAGE_VERSION = "2.9.3-2.9.4";
const RUBY_LANGUAGES = new Set(["ruby", "rb"]);

const RUBY_RUNTIMES = {
	head: {
		label: "Ruby HEAD",
		url: `https://cdn.jsdelivr.net/npm/@ruby/head-wasm-wasi@${RUBY_WASM_PACKAGE_VERSION}/dist/ruby.wasm`,
	},
	"4.0": {
		label: "Ruby 4.0",
		url: `https://cdn.jsdelivr.net/npm/@ruby/4.0-wasm-wasi@${RUBY_WASM_PACKAGE_VERSION}/dist/ruby.wasm`,
	},
	"3.4": {
		label: "Ruby 3.4",
		url: `https://cdn.jsdelivr.net/npm/@ruby/3.4-wasm-wasi@${RUBY_WASM_PACKAGE_VERSION}/dist/ruby.wasm`,
	},
	"3.3": {
		label: "Ruby 3.3",
		url: `https://cdn.jsdelivr.net/npm/@ruby/3.3-wasm-wasi@${RUBY_WASM_PACKAGE_VERSION}/dist/ruby.wasm`,
	},
	"3.2": {
		label: "Ruby 3.2",
		url: `https://cdn.jsdelivr.net/npm/@ruby/3.2-wasm-wasi@${RUBY_WASM_PACKAGE_VERSION}/dist/ruby.wasm`,
	},
} as const;

type RubyRuntimeId = keyof typeof RUBY_RUNTIMES;

interface RubyWasmPluginSettings {
	rubyVersion: RubyRuntimeId;
}

interface RubyCodeBlock {
	startLine: number;
	endLine: number;
	code: string;
}

interface RubyExecutionError {
	title: string;
	details: string;
}

interface RubyExecutionResult {
	code: string;
	runtimeLabel: string;
	stdout: string;
	stderr: string;
	result: string;
	hasResult: boolean;
	error: RubyExecutionError | null;
}

interface RubyRuntimeCapture {
	stdout: string[];
	stderr: string[];
}

interface RubyRuntimeSession {
	vm: RubyVM;
	setCapture: (capture: RubyRuntimeCapture | null) => void;
}

interface EditorExecutionTarget {
	code: string;
	block: RubyCodeBlock | null;
	from: EditorPosition | null;
	to: EditorPosition | null;
}

const DEFAULT_SETTINGS: RubyWasmPluginSettings = {
	rubyVersion: "3.3",
};

const formatError = (error: unknown) =>
	error instanceof Error ? error.toString() : String(error);

const formatExecutionError = (error: unknown): RubyExecutionError => {
	if (error instanceof Error) {
		return {
			title: error.name || "Ruby error",
			details: error.stack ?? error.toString(),
		};
	}

	return {
		title: "Ruby error",
		details: String(error),
	};
};

const isRubyRuntimeId = (value: string): value is RubyRuntimeId =>
	Object.prototype.hasOwnProperty.call(RUBY_RUNTIMES, value);

const compileWebAssemblyModule = (buffer: ArrayBuffer) =>
	WebAssembly.compile(buffer);

const normalizeRubyOutput = (chunks: string[]) => chunks.join("");

const parseFenceLine = (line: string) => {
	const match = line.trim().match(/^(```+|~~~+)\s*([^\s`~]*)?/);
	if (!match) {
		return null;
	}

	return {
		fence: match[1],
		language: match[2]?.toLowerCase() ?? "",
	};
};

const createExecutionSection = (
	containerEl: HTMLElement,
	label: string,
	content: string,
	className: string
) => {
	const sectionEl = containerEl.createDiv({
		cls: `ruby-execution-section ${className}`.trim(),
	});
	sectionEl.createDiv({ cls: "ruby-execution-label", text: label });
	sectionEl.createEl("pre", {
		cls: "ruby-execution-body",
		text: content.length > 0 ? content : "(empty)",
	});
};

const renderExecutionResult = (
	containerEl: HTMLElement,
	execution: RubyExecutionResult
) => {
	containerEl.empty();
	containerEl.removeClass("is-empty");
	containerEl.removeClass("is-loading");
	containerEl.addClass("ruby-execution");

	containerEl.createDiv({
		cls: "ruby-execution-runtime",
		text: execution.runtimeLabel,
	});

	if (execution.stdout) {
		createExecutionSection(
			containerEl,
			"Stdout",
			execution.stdout,
			"is-stdout"
		);
	}

	if (execution.stderr) {
		createExecutionSection(
			containerEl,
			"Stderr",
			execution.stderr,
			"is-stderr"
		);
	}

	if (execution.hasResult) {
		createExecutionSection(
			containerEl,
			"Return value",
			execution.result,
			"is-result"
		);
	}

	if (execution.error) {
		createExecutionSection(
			containerEl,
			execution.error.title,
			execution.error.details,
			"is-error"
		);
	}
};

const renderExecutionLoading = (containerEl: HTMLElement, runtimeLabel: string) => {
	containerEl.empty();
	containerEl.removeClass("is-empty");
	containerEl.addClass("is-loading");
	containerEl.createDiv({
		cls: "ruby-execution-runtime",
		text: runtimeLabel,
	});
	containerEl.createDiv({
		cls: "ruby-execution-status",
		text: "Running Ruby code...",
	});
};

const formatExecutionMarkdown = (execution: RubyExecutionResult) => {
	const sections = [`runtime: ${execution.runtimeLabel}`];

	if (execution.stdout) {
		sections.push(`stdout:\n${execution.stdout}`);
	}

	if (execution.stderr) {
		sections.push(`stderr:\n${execution.stderr}`);
	}

	if (execution.hasResult) {
		sections.push(`result:\n${execution.result.length > 0 ? execution.result : "(empty)"}`);
	}

	if (execution.error) {
		sections.push(`${execution.error.title}:\n${execution.error.details}`);
	}

	return `\n\n\`\`\`text\n${sections.join("\n\n")}\n\`\`\``;
};

export default class RubyWasmPlugin extends Plugin {
	settings: RubyWasmPluginSettings = DEFAULT_SETTINGS;
	private rubyVmPromise: Promise<RubyRuntimeSession> | null = null;
	private executionQueue: Promise<void> = Promise.resolve();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new RubyWasmSettingTab(this.app, this));

		this.addCommand({
			id: "run-in-modal",
			name: "Run in Modal",
			editorCallback: async (editor: Editor) => {
				try {
					const target = this.getEditorExecutionTarget(editor);
					const execution = await this.executeRuby(target.code);
					new CodeModal(this.app, execution).open();
				} catch (error) {
					this.showRuntimeLoadError(error);
				}
			},
		});

		this.addCommand({
			id: "run-in-editor",
			name: "Run in Editor",
			editorCallback: async (editor: Editor) => {
				try {
					const target = this.getEditorExecutionTarget(editor);
					const execution = await this.executeRuby(target.code);
					this.insertExecutionResult(editor, target, execution);
				} catch (error) {
					this.showRuntimeLoadError(error);
				}
			},
		});

		this.registerMarkdownPostProcessor((el, ctx) => {
			this.enhanceRubyCodeBlocks(el, ctx);
		});
	}

	onunload() {
		this.rubyVmPromise = null;
		this.executionQueue = Promise.resolve();
	}

	async updateRubyVersion(rubyVersion: RubyRuntimeId) {
		if (this.settings.rubyVersion === rubyVersion) {
			return;
		}

		this.settings = {
			...this.settings,
			rubyVersion,
		};
		this.rubyVmPromise = null;
		await this.saveSettings();
		new Notice(`Using ${this.getSelectedRuntime().label}.`);
	}

	getSelectedRuntimeLabel() {
		return this.getSelectedRuntime().label;
	}

	async executeRuby(code: string): Promise<RubyExecutionResult> {
		const runtimeLabel = this.getSelectedRuntime().label;
		const run = async () => {
			const runtime = await this.getRubyVM();
			const capture: RubyRuntimeCapture = {
				stdout: [],
				stderr: [],
			};

			runtime.setCapture(capture);

			try {
				const value = runtime.vm.eval(code);
				return {
					code,
					runtimeLabel,
					stdout: normalizeRubyOutput(capture.stdout),
					stderr: normalizeRubyOutput(capture.stderr),
					result: value.toString(),
					hasResult: true,
					error: null,
				};
			} catch (error) {
				return {
					code,
					runtimeLabel,
					stdout: normalizeRubyOutput(capture.stdout),
					stderr: normalizeRubyOutput(capture.stderr),
					result: "",
					hasResult: false,
					error: formatExecutionError(error),
				};
			} finally {
				runtime.setCapture(null);
			}
		};

		const resultPromise = this.executionQueue.then(run, run);
		this.executionQueue = resultPromise.then(
			() => undefined,
			() => undefined
		);
		return resultPromise;
	}

	private showRuntimeLoadError(error: unknown) {
		new Notice(
			`Failed to load ${this.getSelectedRuntime().label}: ${formatError(error)}`
		);
	}

	private getEditorExecutionTarget(editor: Editor): EditorExecutionTarget {
		if (editor.somethingSelected()) {
			return {
				code: editor.getSelection(),
				block: this.getRubyCodeBlock(editor, editor.getCursor("from").line),
				from: editor.getCursor("from"),
				to: editor.getCursor("to"),
			};
		}

		const block = this.getRubyCodeBlock(editor, editor.getCursor().line);
		if (block) {
			return {
				code: block.code,
				block,
				from: null,
				to: null,
			};
		}

		throw new Error(
			"Select Ruby code or place the cursor inside a ruby code block."
		);
	}

	private getRubyCodeBlock(editor: Editor, line: number): RubyCodeBlock | null {
		for (let current = line; current >= 0; current--) {
			const fence = parseFenceLine(editor.getLine(current));
			if (!fence) {
				continue;
			}

			if (!RUBY_LANGUAGES.has(fence.language)) {
				return null;
			}

			for (let endLine = current + 1; endLine < editor.lineCount(); endLine++) {
				const endFence = parseFenceLine(editor.getLine(endLine));
				if (!endFence || endFence.fence !== fence.fence) {
					continue;
				}

				if (line > endLine) {
					return null;
				}

				const code = editor.getRange(
					{ line: current + 1, ch: 0 },
					{ line: endLine, ch: 0 }
				);

				return {
					startLine: current,
					endLine,
					code,
				};
			}

			return null;
		}

		return null;
	}

	private insertExecutionResult(
		editor: Editor,
		target: EditorExecutionTarget,
		execution: RubyExecutionResult
	) {
		const output = formatExecutionMarkdown(execution);

		if (target.block) {
			const closingLine = editor.getLine(target.block.endLine);
			editor.replaceRange(output, {
				line: target.block.endLine,
				ch: closingLine.length,
			});
			return;
		}

		if (target.to) {
			editor.replaceRange(output, target.to);
			return;
		}

		editor.replaceSelection(output);
	}

	private enhanceRubyCodeBlocks(
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		const codeBlocks = Array.from(
			el.querySelectorAll("pre > code.language-ruby")
		);

		for (const codeEl of codeBlocks) {
			const preEl = codeEl.parentElement;
			if (!(preEl instanceof HTMLElement)) {
				continue;
			}

			if (preEl.parentElement?.classList.contains("ruby-repl-block")) {
				continue;
			}

			const wrapperEl = createDiv({ cls: "ruby-repl-block" });
			preEl.parentElement?.insertBefore(wrapperEl, preEl);
			wrapperEl.appendChild(preEl);

			ctx.addChild(
				new RubyCodeBlockRenderChild(
					wrapperEl,
					this,
					codeEl.textContent ?? ""
				)
			);
		}
	}

	private async getRubyVM(): Promise<RubyRuntimeSession> {
		if (!this.rubyVmPromise) {
			this.rubyVmPromise = this.createRubyVM();
		}

		return this.rubyVmPromise;
	}

	private async createRubyVM(): Promise<RubyRuntimeSession> {
		const runtime = this.getSelectedRuntime();
		const loadingNotice = new Notice(`Loading ${runtime.label}...`, 0);
		let capture: RubyRuntimeCapture | null = null;

		try {
			const { File, OpenFile, PreopenDirectory, WASI } = await import(
				"@bjorn3/browser_wasi_shim"
			);
			const response = await requestUrl({
				url: runtime.url,
				method: "GET",
				throw: false,
			});
			if (response.status !== 200) {
				throw new Error(
					`Runtime download failed with status ${response.status}.`
				);
			}

			const module = await compileWebAssemblyModule(response.arrayBuffer);
			const wasi = new WASI(
				[],
				[],
				[
					new OpenFile(new File([])),
					new OpenFile(new File([])),
					new OpenFile(new File([])),
					new PreopenDirectory("/", new Map()),
				],
				{ debug: false }
			);
			const printer = consolePrinter({
				stdout: (text) => capture?.stdout.push(text),
				stderr: (text) => capture?.stderr.push(text),
			});
			const { vm } = await RubyVM.instantiateModule({
				module,
				wasip1: wasi,
				addToImports: (imports) => {
					printer.addToImports(imports);
				},
				setMemory: (memory) => {
					printer.setMemory(memory);
				},
			});

			return {
				vm,
				setCapture: (nextCapture) => {
					capture = nextCapture;
				},
			};
		} catch (error) {
			this.rubyVmPromise = null;
			throw error;
		} finally {
			loadingNotice.hide();
		}
	}

	private async loadSettings() {
		const loadedData = await this.loadData();
		const rubyVersion = isRubyRuntimeId(loadedData?.rubyVersion)
			? loadedData.rubyVersion
			: DEFAULT_SETTINGS.rubyVersion;

		this.settings = {
			...DEFAULT_SETTINGS,
			...loadedData,
			rubyVersion,
		};
	}

	private async saveSettings() {
		await this.saveData(this.settings);
	}

	private getSelectedRuntime() {
		return RUBY_RUNTIMES[this.settings.rubyVersion];
	}
}

class CodeModal extends Modal {
	execution: RubyExecutionResult;

	constructor(app: App, execution: RubyExecutionResult) {
		super(app);
		this.execution = execution;
	}

	async onOpen() {
		const { contentEl } = this;

		const codeBlock = contentEl.createEl("pre", {
			cls: "language-ruby",
		});
		const codeElement = codeBlock.createEl("code", {
			cls: "language-ruby",
		});
		codeElement.textContent = this.execution.code || "code";

		const resultElement = contentEl.createDiv({
			cls: "ruby-output",
		});
		renderExecutionResult(resultElement, this.execution);

		const closeButton = contentEl.createEl("button", {
			cls: "modal-button",
			attr: { type: "button" },
			text: "Close",
		});
		closeButton.addEventListener("click", () => {
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class RubyCodeBlockRenderChild extends MarkdownRenderChild {
	plugin: RubyWasmPlugin;
	source: string;
	runButtonEl: HTMLButtonElement;
	outputEl: HTMLDivElement;
	runtimeEl: HTMLSpanElement;

	constructor(containerEl: HTMLElement, plugin: RubyWasmPlugin, source: string) {
		super(containerEl);
		this.plugin = plugin;
		this.source = source;

		const toolbarEl = containerEl.createDiv({ cls: "ruby-repl-toolbar" });
		this.runButtonEl = toolbarEl.createEl("button", {
			cls: "clickable-icon ruby-repl-run-button",
			attr: { type: "button", "aria-label": "Run Ruby code block" },
			text: "Run",
		});
		this.runtimeEl = toolbarEl.createEl("span", {
			cls: "ruby-repl-runtime",
			text: plugin.getSelectedRuntimeLabel(),
		});
		this.outputEl = containerEl.createDiv({
			cls: "ruby-output ruby-repl-panel is-empty",
		});
	}

	onload() {
		this.registerDomEvent(this.runButtonEl, "click", () => {
			void this.runCodeBlock();
		});
	}

	private async runCodeBlock() {
		this.runButtonEl.disabled = true;
		renderExecutionLoading(this.outputEl, this.plugin.getSelectedRuntimeLabel());

		try {
			const execution = await this.plugin.executeRuby(this.source);
			this.runtimeEl.textContent = execution.runtimeLabel;
			renderExecutionResult(this.outputEl, execution);
		} catch (error) {
			this.runtimeEl.textContent = this.plugin.getSelectedRuntimeLabel();
			renderExecutionResult(this.outputEl, {
				code: this.source,
				runtimeLabel: this.plugin.getSelectedRuntimeLabel(),
				stdout: "",
				stderr: "",
				result: "",
				hasResult: false,
				error: formatExecutionError(error),
			});
		} finally {
			this.runButtonEl.disabled = false;
		}
	}
}

class RubyWasmSettingTab extends PluginSettingTab {
	plugin: RubyWasmPlugin;

	constructor(app: App, plugin: RubyWasmPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Ruby version")
			.setDesc(
				"Choose which Ruby runtime to download from jsDelivr when commands run."
			)
			.addDropdown((dropdown) => {
				dropdown.addOptions(
					Object.fromEntries(
						Object.entries(RUBY_RUNTIMES).map(([id, runtime]) => [
							id,
							runtime.label,
						])
					)
				);
				dropdown.setValue(this.plugin.settings.rubyVersion);
				dropdown.onChange(async (value) => {
					if (!isRubyRuntimeId(value)) {
						new Notice(`Unsupported Ruby version: ${value}`);
						return;
					}

					await this.plugin.updateRubyVersion(value);
				});
			});
	}
}
