/*
ABOUTME: Registers Obsidian commands that run selected Ruby code in a modal or inline.
ABOUTME: Lazily downloads the ruby.wasm runtime so the release bundle stays sync-friendly.
*/
import {
	App,
	Editor,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
} from "obsidian";
import { DefaultRubyVM } from "@ruby/wasm-wasi/dist/browser";
import type { RubyVM } from "@ruby/wasm-wasi";

const RUBY_WASM_PACKAGE_VERSION = "2.9.3-2.9.4";

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

const DEFAULT_SETTINGS: RubyWasmPluginSettings = {
	rubyVersion: "3.3",
};

const formatError = (error: unknown) =>
	error instanceof Error ? error.toString() : String(error);

const isRubyRuntimeId = (value: string): value is RubyRuntimeId =>
	Object.prototype.hasOwnProperty.call(RUBY_RUNTIMES, value);

const compileWebAssemblyModule = (buffer: ArrayBuffer) =>
	WebAssembly.compile(buffer);

export default class RubyWasmPlugin extends Plugin {
	settings: RubyWasmPluginSettings = DEFAULT_SETTINGS;
	private rubyVmPromise: Promise<RubyVM> | null = null;

	// Function to check if inside code block
	isInCodeBlock = (editor: Editor, line: number) => {
		const totalLines = editor.lineCount();
		let inCodeBlock = true;
		for (let i = line; i >= 0; i--) {
			const lineText = editor.getLine(i).trim();
			if (lineText.startsWith("```")) {
				inCodeBlock = !inCodeBlock;
			}
		}
		for (let i = line + 1; i < totalLines; i++) {
			const lineText = editor.getLine(i).trim();
			if (lineText.startsWith("```")) {
				inCodeBlock = !inCodeBlock;
				break;
			}
		}
		return inCodeBlock;
	};

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new RubyWasmSettingTab(this.app, this));

		const showRuntimeLoadError = (error: unknown) => {
			new Notice(
				`Failed to load ${this.getSelectedRuntime().label}: ${formatError(
					error
				)}`
			);
		};

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "run-in-modal",
			name: "Run in Modal",
			editorCallback: async (editor: Editor) => {
				try {
					const { code, result } = await this.runRuby(editor);
					new CodeModal(this.app, code, result).open();
				} catch (error) {
					showRuntimeLoadError(error);
				}
			},
		});

		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: "run-in-editor",
			name: "Run in Editor",
			editorCallback: async (editor: Editor) => {
				try {
					const { code, result } = await this.runRuby(editor);
					const cursorLine = editor.getCursor().line;
					const insideCode = this.isInCodeBlock(editor, cursorLine);

					if (insideCode) {
						editor.replaceSelection(`${code}\n# => ${result}`);
					} else {
						editor.replaceSelection(
							`${code}\n\`\`\`\n${result}\n\`\`\``
						);
					}
				} catch (error) {
					showRuntimeLoadError(error);
				}
			},
		});

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, "click", (evt: MouseEvent) => {
		// 	console.log("click", evt);
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		// this.registerInterval(
		// 	window.setInterval(() => console.log("setInterval"), 5 * 60 * 1000)
		// );
	}

	onunload() {
		this.rubyVmPromise = null;
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

	private async runRuby(editor: Editor) {
		const code = editor.getSelection();
		const vm = await this.getRubyVM();

		try {
			return { code, result: vm.eval(code).toString() };
		} catch (error) {
			return { code, result: formatError(error) };
		}
	}

	private async getRubyVM(): Promise<RubyVM> {
		if (!this.rubyVmPromise) {
			this.rubyVmPromise = this.createRubyVM();
		}

		return this.rubyVmPromise;
	}

	private async createRubyVM(): Promise<RubyVM> {
		const runtime = this.getSelectedRuntime();
		const loadingNotice = new Notice(`Loading ${runtime.label}...`, 0);

		try {
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
			const { vm } = await DefaultRubyVM(module);
			return vm;
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
	code: string;
	result: string;
	constructor(app: App, code: string, result: string) {
		super(app);
		this.code = code;
		this.result = result;
	}

	async onOpen() {
		const { contentEl } = this;

		// contentEl.createEl("h1", { text: "Code" });
		const codeBlock = contentEl.createEl("pre", {
			cls: "language-ruby",
		});
		const codeElement = codeBlock.createEl("code", {
			cls: "language-ruby",
		});
		codeElement.textContent = this.code || "code";

		const resultElement = contentEl.createDiv({
			cls: "ruby-output",
		});
		resultElement.textContent = this.result || "result";

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
