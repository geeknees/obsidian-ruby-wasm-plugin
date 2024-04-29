import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

import { DefaultRubyVM } from "@ruby/wasm-wasi/dist/browser";

// Remember to rename these classes and interfaces!

interface RubyWasmPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: RubyWasmPluginSettings = {
	mySetting: "default",
};

export default class RubyWasmPlugin extends Plugin {
	settings: RubyWasmPluginSettings;

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

		const response = await fetch(
			"https://cdn.jsdelivr.net/npm/@ruby/3.3-wasm-wasi@2.5.1/dist/ruby+stdlib.wasm"
		);
		const module = await WebAssembly.compileStreaming(response);
		const { vm } = await DefaultRubyVM(module);

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "run-in-modal",
			name: "Run in Modal",
			editorCallback: (editor: Editor) => {
				const code = editor.getSelection();
				let result;
				try {
					result = vm.eval(code).toString();
				} catch (e) {
					result = e.toString();
				}
				// console.log(code);
				new CodeModal(this.app, code, result).open();
			},
		});

		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: "run-in-editor",
			name: "Run in Editor",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const code = editor.getSelection();
				let result;
				try {
					result = vm.eval(code).toString();
				} catch (e) {
					result = e.toString();
				}
				// console.log(code);
				const cursorLine = editor.getCursor().line;
				const insideCode = this.isInCodeBlock(editor, cursorLine);

				if (insideCode) {
					editor.replaceSelection(`${code}\n# => ${result}`);
				} else {
					editor.replaceSelection(
						`${code}\n\`\`\`\n${result}\n\`\`\``
					);
				}
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new RubyWasmSettingTab(this.app, this));

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

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
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

		const resultElement = contentEl.createEl("div", {
			cls: "ruby-output",
			attr: { style: "white-space: pre-wrap;" },
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

		new Setting(containerEl).setName("ruby.wasm");
		// .setDesc("It's a secret");
		// .addText((text) =>
		// 	text
		// 		.setPlaceholder("Enter your secret")
		// 		.setValue(this.plugin.settings.mySetting)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.mySetting = value;
		// 			await this.plugin.saveSettings();
		// 		})
		// );
	}
}
